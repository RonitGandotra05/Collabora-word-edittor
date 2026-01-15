/* -*- js-indent-level: 8; fill-column: 100 -*- */
/*
 * Copyright the Collabora Online contributors.
 *
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Control.WordMeta - Invisible word-level metadata using hidden bookmarks
 * 
 * Allows attaching arbitrary properties (timestamps, speaker, confidence, etc.)
 * to individual words in a document. Uses Collabora's native bookmark system
 * with custom properties for storage.
 * 
 * Usage:
 *   app.map.wordMeta.importFromJSON([{word: "Hello", start: 0.5, end: 1.0, confidence: 0.98}, ...])
 *   app.map.wordMeta.getWordMeta(0)           // Get metadata for word at index 0
 *   app.map.wordMeta.navigateToWord(50)       // Go to word 50
 *   app.map.wordMeta.findWordByTime(30.5)     // Find word at 30.5 seconds
 */

/* global app */
window.L.Control.WordMeta = window.L.Control.extend({

    // In-memory storage of word metadata (lazy - bookmarks created on demand)
    _wordMetadata: [],       // Array of {word, start, end, confidence, ...}
    _bookmarksCreated: {},   // Track which bookmarks exist: { wordIndex: bookmarkName }
    _isLoaded: false,
    _indexingActive: false,
    _indexingToken: 0,
    _indexQueue: [],
    _indexingBatchSize: 50,
    _indexingBatchDelayMs: 10,
    _searchTimeoutMs: 1500,
    _searchToken: 0,
    _searchStartPoint: null,
    _highlightDebounceMs: 80,
    _highlightJumpDelayMs: 60,
    _highlightSearchTimeoutMs: 800,
    _highlightTimer: null,
    _highlightSearchActive: false,
    _highlightSearchToken: 0,
    _pendingHighlightIndex: -1,
    _lastHighlightIndex: -1,
    _hasActiveHighlight: false,
    _storeMetadataProperties: false,
    _indexingPaused: false,
    _indexingTargetCount: 0,
    _indexingDoneCount: 0,
    _useExistingBookmarks: true,
    _existingBookmarksFetched: false,
    _existingBookmarksTimer: null,
    _bookmarkFetchTimeoutMs: 1500,

    // Bookmark naming prefix
    BOOKMARK_PREFIX: 'WMETA_',

    onAdd: function (map) {
        this.map = map;
        this._wordMetadata = [];
        this._bookmarksCreated = {};
        this._isLoaded = false;
        this._indexingActive = false;
        this._indexingToken = 0;
        this._indexQueue = [];
        this._searchStartPoint = null;
        this._pendingHighlightIndex = -1;
        this._lastHighlightIndex = -1;
        this._hasActiveHighlight = false;
        this._highlightSearchActive = false;
        this._highlightSearchToken = 0;
        this._indexingPaused = false;
        this._indexingTargetCount = 0;
        this._indexingDoneCount = 0;
        this._existingBookmarksFetched = false;
        this._existingBookmarksTimer = null;

        // Register this control on the map for easy access
        map.wordMeta = this;

        console.log('WordMeta: Control initialized');
    },

    /**
     * Import word metadata from JSON array
     * Format: [{word: "Hello", start: 0.52, end: 0.94, confidence: 0.98}, ...]
     * Times are in seconds (float)
     * 
     * @param {Array} wordsArray - Array of word objects with metadata
     */
    importFromJSON: function (wordsArray) {
        if (!Array.isArray(wordsArray)) {
            console.error('WordMeta: importFromJSON expects an array');
            return false;
        }

        this._cancelIndexing();
        this._wordMetadata = wordsArray.map(function (item, index) {
            return {
                index: index,
                word: item.word || '',
                start: item.start || 0,      // seconds
                end: item.end || 0,          // seconds
                confidence: item.confidence || 1.0,
                // Store any additional properties
                ...item
            };
        });

        this._isLoaded = true;
        console.log('WordMeta: Imported ' + this._wordMetadata.length + ' words');
        this._beginIndexing();

        return true;
    },

    /**
     * Get metadata for a specific word by index
     * @param {number} wordIndex - Index of the word (0-based)
     * @returns {Object|null} Word metadata or null if not found
     */
    getWordMeta: function (wordIndex) {
        if (wordIndex < 0 || wordIndex >= this._wordMetadata.length) {
            return null;
        }
        return this._wordMetadata[wordIndex];
    },

    /**
     * Get all word metadata
     * @returns {Array} All word metadata
     */
    getAllMetadata: function () {
        return this._wordMetadata;
    },

    hasBookmark: function (wordIndex) {
        return !!this._bookmarksCreated[wordIndex];
    },

    /**
     * Find word index by timestamp (binary search for efficiency)
     * @param {number} timeSeconds - Time in seconds
     * @returns {number} Word index, or -1 if not found
     */
    findWordByTime: function (timeSeconds) {
        if (!this._isLoaded || this._wordMetadata.length === 0) {
            return -1;
        }

        // Binary search for the word at this timestamp
        var left = 0;
        var right = this._wordMetadata.length - 1;
        var result = -1;

        while (left <= right) {
            var mid = Math.floor((left + right) / 2);
            var word = this._wordMetadata[mid];

            if (timeSeconds >= word.start && timeSeconds <= word.end) {
                return mid;
            } else if (timeSeconds < word.start) {
                right = mid - 1;
            } else {
                result = mid; // Keep track of last word before this time
                left = mid + 1;
            }
        }

        return result;
    },

    /**
     * Find words by any property value
     * @param {string} key - Property name to search
     * @param {any} value - Value to match
     * @returns {Array} Array of matching word indices
     */
    findWordsByProperty: function (key, value) {
        var matches = [];
        for (var i = 0; i < this._wordMetadata.length; i++) {
            if (this._wordMetadata[i][key] === value) {
                matches.push(i);
            }
        }
        return matches;
    },

    /**
     * Create a hidden bookmark for a word (lazy loading)
     * @param {number} wordIndex - Index of the word
     * @returns {string} Bookmark name
     */
    _createBookmarkForWord: function (wordIndex) {
        if (this._bookmarksCreated[wordIndex]) {
            return this._bookmarksCreated[wordIndex];
        }

        var word = this._wordMetadata[wordIndex];
        if (!word) {
            console.error('WordMeta: No metadata for word index ' + wordIndex);
            return null;
        }

        var bookmarkName = this._getBookmarkName(wordIndex);
        var params = {
            'Bookmark': {
                'type': 'string',
                'value': bookmarkName
            }
        };
        this.map.sendUnoCommand('.uno:InsertBookmark', params, true);
        if (this._storeMetadataProperties) {
            this._setCustomProperty(bookmarkName, JSON.stringify({
                index: wordIndex,
                start: word.start,
                end: word.end,
                confidence: word.confidence
            }));
        }

        this._bookmarksCreated[wordIndex] = bookmarkName;
        console.log('WordMeta: Created bookmark ' + bookmarkName + ' for word "' + word.word + '"');

        return bookmarkName;
    },

    /**
     * Set custom document property (following Zotero pattern)
     * @param {string} prefix - Property name prefix
     * @param {string} value - JSON string value
     */
    _setCustomProperty: function (prefix, value) {
        var property = {
            'UpdatedProperties': {
                'type': '[]com.sun.star.beans.PropertyValue',
                'value': {
                    'NamePrefix': {
                        'type': 'string',
                        'value': prefix + '_'
                    },
                    'UserDefinedProperties': {
                        'type': '[]com.sun.star.beans.PropertyValue',
                        'value': {}
                    }
                }
            }
        };

        // Split into chunks of 255 chars (LibreOffice limitation)
        for (var start = 0, end = 1; (end * 255) < (value.length + 255); start++, end++) {
            property['UpdatedProperties']['value']['UserDefinedProperties']['value'][prefix + '_' + end] = {
                'type': 'string',
                'value': value.slice(start * 255, end * 255)
            };
        }

        this.map.sendUnoCommand('.uno:SetDocumentProperties', property, true);
    },

    /**
     * Navigate to a word by index and highlight it
     * @param {number} wordIndex - Index of the word
     */
    navigateToWord: function (wordIndex) {
        if (wordIndex < 0 || wordIndex >= this._wordMetadata.length) {
            console.error('WordMeta: Invalid word index ' + wordIndex);
            return;
        }

        this._queueHighlight(wordIndex);
    },

    /**
     * Highlight word using document search (fallback method)
     * @param {string} wordText - Text to search for
     * @param {number} occurrence - Which occurrence to highlight (0-based)
     */
    _highlightWordBySearch: function (wordText, occurrence) {
        // Use the find & replace functionality to locate the word
        var searchParams = {
            'SearchItem.SearchString': {
                'type': 'string',
                'value': wordText
            },
            'SearchItem.Backward': {
                'type': 'boolean',
                'value': false
            },
            'SearchItem.SearchStartPointX': {
                'type': 'long',
                'value': 0
            },
            'SearchItem.SearchStartPointY': {
                'type': 'long',
                'value': 0
            },
            'SearchItem.Command': {
                'type': 'long',
                'value': 0
            }
        };

        // Execute search from beginning, skip to nth occurrence
        this.map.sendUnoCommand('.uno:ExecuteSearch', searchParams, true);
    },

    /**
     * Navigate to word at specific timestamp
     * @param {number} timeSeconds - Time in seconds
     */
    navigateToTime: function (timeSeconds) {
        var wordIndex = this.findWordByTime(timeSeconds);
        if (wordIndex >= 0) {
            this._queueHighlight(wordIndex);
        }
    },

    /**
     * Get total word count
     * @returns {number} Number of words with metadata
     */
    getWordCount: function () {
        return this._wordMetadata.length;
    },

    /**
     * Check if metadata is loaded
     * @returns {boolean} True if metadata is loaded
     */
    isLoaded: function () {
        return this._isLoaded;
    },

    /**
     * Clear all metadata
     */
    clear: function () {
        this._cancelIndexing();
        this._wordMetadata = [];
        this._bookmarksCreated = {};
        this._isLoaded = false;
        console.log('WordMeta: Cleared all metadata');
    },

    /**
     * Export metadata back to JSON format
     * @returns {Array} Word metadata array
     */
    exportToJSON: function () {
        return this._wordMetadata.map(function (word) {
            return {
                word: word.word,
                start: word.start,
                end: word.end,
                confidence: word.confidence
            };
        });
    },

    /**
     * Get time range for entire document
     * @returns {Object} {start, end} in seconds
     */
    getTimeRange: function () {
        if (!this._isLoaded || this._wordMetadata.length === 0) {
            return { start: 0, end: 0 };
        }
        return {
            start: this._wordMetadata[0].start,
            end: this._wordMetadata[this._wordMetadata.length - 1].end
        };
    },

    _getBookmarkName: function (wordIndex) {
        return this.BOOKMARK_PREFIX + wordIndex;
    },

    _deleteAllBookmarks: function () {
        var params = {
            'BookmarkNamePrefix': {
                'type': 'string',
                'value': this.BOOKMARK_PREFIX
            }
        };
        this.map.sendUnoCommand('.uno:DeleteBookmarks', params, true);
        this._bookmarksCreated = {};
    },

    _beginIndexing: function () {
        if (!this._isLoaded || this._wordMetadata.length === 0) {
            return;
        }

        if (this._useExistingBookmarks) {
            this._log('debug', 'WordMeta: Requesting existing bookmarks with prefix ' + this.BOOKMARK_PREFIX);
            this._requestExistingBookmarks();
            return;
        }

        this._log('debug', 'WordMeta: No existing bookmarks. Starting background indexing.');
        this._resetBookmarksAndIndex();
    },

    _cancelIndexing: function () {
        this._indexingActive = false;
        this._indexQueue = [];
        this._searchStartPoint = null;
        if (this._existingBookmarksTimer) {
            clearTimeout(this._existingBookmarksTimer);
            this._existingBookmarksTimer = null;
        }
        if (this._highlightTimer) {
            clearTimeout(this._highlightTimer);
            this._highlightTimer = null;
        }
        this._highlightSearchActive = false;
        this._hasActiveHighlight = false;
    },

    _requestExistingBookmarks: function () {
        var that = this;
        this._existingBookmarksFetched = false;
        if (this._existingBookmarksTimer) {
            clearTimeout(this._existingBookmarksTimer);
        }

        this._log('debug', 'WordMeta: Waiting for existing bookmark list...');
        this._existingBookmarksTimer = setTimeout(function () {
            if (that._existingBookmarksFetched) {
                return;
            }
            that._existingBookmarksFetched = true;
            that._log('warn', 'WordMeta: Existing bookmark list timed out. Falling back to indexing.');
            that._resetBookmarksAndIndex();
        }, this._bookmarkFetchTimeoutMs);

        if (app && app.socket) {
            app.socket.sendMessage('commandvalues command=.uno:Bookmarks?namePrefix=' + this.BOOKMARK_PREFIX);
        }
    },

    handleBookmarks: function (bookmarks) {
        if (!this._useExistingBookmarks || !Array.isArray(bookmarks) || !this._isLoaded) {
            return false;
        }

        var matched = false;
        this._bookmarksCreated = {};

        for (var i = 0; i < bookmarks.length; i++) {
            var name = bookmarks[i].name;
            if (!name || name.indexOf(this.BOOKMARK_PREFIX) !== 0) {
                continue;
            }

            var indexText = name.substring(this.BOOKMARK_PREFIX.length);
            var index = parseInt(indexText, 10);
            if (isNaN(index) || index < 0 || index >= this._wordMetadata.length) {
                continue;
            }

            this._bookmarksCreated[index] = name;
            matched = true;
        }

        if (!matched) {
            this._log('warn', 'WordMeta: No existing WMETA bookmarks found. Indexing all words.');
            return false;
        }

        this._existingBookmarksFetched = true;
        if (this._existingBookmarksTimer) {
            clearTimeout(this._existingBookmarksTimer);
            this._existingBookmarksTimer = null;
        }

        this._log('debug', 'WordMeta: Reused ' + Object.keys(this._bookmarksCreated).length + ' existing bookmarks.');
        this._startIndexingFromMissing();
        return true;
    },

    _resetBookmarksAndIndex: function () {
        this._deleteAllBookmarks();
        this._bookmarksCreated = {};
        this._startIndexingFromMissing();
    },

    _startIndexingFromMissing: function () {
        if (!this._isLoaded || this._wordMetadata.length === 0) {
            return;
        }

        this._indexingActive = true;
        this._indexingToken += 1;
        this._indexQueue = [];
        this._searchStartPoint = null;
        this._pendingHighlightIndex = -1;
        this._lastHighlightIndex = -1;
        this._indexingDoneCount = 0;

        for (var i = 0; i < this._wordMetadata.length; i++) {
            if (!this._bookmarksCreated[i]) {
                this._indexQueue.push(i);
            }
        }
        this._indexingTargetCount = this._indexQueue.length;
        this._log('debug', 'WordMeta: Indexing target count: ' + this._indexingTargetCount);

        if (this._indexQueue.length === 0) {
            this._indexingActive = false;
            console.log('WordMeta: Using existing bookmarks');
            this._emitIndexReady();
            return;
        }

        this.map.sendUnoCommand('.uno:GoToStart', null, true);
        this._scheduleIndexingBatch(this._indexingToken);
    },

    _scheduleIndexingBatch: function (token) {
        var that = this;
        setTimeout(function () {
            that._processIndexingBatch(token);
        }, this._indexingBatchDelayMs);
    },

    _processIndexingBatch: function (token) {
        if (!this._indexingActive || token !== this._indexingToken) {
            return;
        }
        if (this._indexingPaused) {
            this._scheduleIndexingBatch(token);
            return;
        }

        var remaining = this._indexingBatchSize;
        var that = this;
        this._log('debug', 'WordMeta: Processing batch, remaining queue: ' + this._indexQueue.length);

        var processNext = function () {
            if (!that._indexingActive || token !== that._indexingToken) {
                return;
            }
            if (that._indexQueue.length === 0) {
                that._indexingActive = false;
                console.log('WordMeta: Bookmark indexing complete');
                that._emitIndexReady();
                return;
            }
            if (remaining <= 0) {
                that._scheduleIndexingBatch(token);
                return;
            }

            remaining -= 1;
            var wordIndex = that._indexQueue.shift();
            that._indexWord(wordIndex, token).then(function () {
                processNext();
            });
        };

        processNext();
    },

    _indexWord: function (wordIndex, token) {
        var word = this._wordMetadata[wordIndex];
        if (!word || !word.word) {
            return Promise.resolve(false);
        }

        var that = this;
        return this._searchForWord(word.word, token).then(function (result) {
            if (!that._indexingActive || token !== that._indexingToken) {
                return false;
            }
            if (!result || !result.count) {
                console.warn('WordMeta: Indexing failed for word "' + word.word + '" at index ' + wordIndex);
                return false;
            }

            that._createBookmarkForWord(wordIndex);
            that._indexingDoneCount += 1;
            that._updateSearchStartPointFromEvent(result);
            return true;
        });
    },

    _searchForWord: function (wordText, token) {
        var that = this;
        var searchToken = this._searchToken + 1;
        this._searchToken = searchToken;

        return new Promise(function (resolve) {
            var resolved = false;

            var onSearch = function (event) {
                if (that._highlightSearchActive) {
                    return;
                }
                if (!that._indexingActive || token !== that._indexingToken) {
                    return;
                }
                if (searchToken !== that._searchToken) {
                    return;
                }
                if (event.originalPhrase !== wordText) {
                    return;
                }

                resolved = true;
                that.map.off('search', onSearch, that);
                resolve(event);
            };

            that.map.on('search', onSearch, that);
            that._executeSearch(wordText);

            setTimeout(function () {
                if (resolved) {
                    return;
                }
                that.map.off('search', onSearch, that);
                resolve(null);
            }, that._searchTimeoutMs);
        });
    },

    _executeSearch: function (wordText, overrideStartPoint) {
        var startPoint = overrideStartPoint || this._getSearchStartPoint();
        var searchParams = {
            'SearchItem.SearchString': {
                'type': 'string',
                'value': wordText
            },
            'SearchItem.ReplaceString': {
                'type': 'string',
                'value': ''
            },
            'SearchItem.Backward': {
                'type': 'boolean',
                'value': false
            },
            'SearchItem.SearchStartPointX': {
                'type': 'long',
                'value': startPoint.x
            },
            'SearchItem.SearchStartPointY': {
                'type': 'long',
                'value': startPoint.y
            },
            'SearchItem.Command': {
                'type': 'long',
                'value': 0
            }
        };

        this.map.fire('clearselection');
        this.map.sendUnoCommand('.uno:ExecuteSearch', searchParams, true);
    },

    _getSearchStartPoint: function () {
        if (this._searchStartPoint) {
            return this._searchStartPoint;
        }

        if (app && app.activeDocument && app.activeDocument.activeLayout && app.activeDocument.activeLayout.viewedRectangle) {
            return {
                x: app.activeDocument.activeLayout.viewedRectangle.x1,
                y: app.activeDocument.activeLayout.viewedRectangle.y1
            };
        }

        return { x: 0, y: 0 };
    },

    _updateSearchStartPointFromEvent: function (event) {
        var rectangles = null;
        if (event && event.results && event.results.length) {
            rectangles = event.results[event.results.length - 1].twipsRectangles;
        } else if (this.map && this.map._docLayer && this.map._docLayer._lastSearchResult) {
            rectangles = this.map._docLayer._lastSearchResult.twipsRectangles;
        }

        if (!rectangles) {
            return;
        }

        var values = rectangles.match(/-?\d+/g);
        if (!values || values.length < 4) {
            return;
        }

        var x2 = parseInt(values[values.length - 2], 10);
        var y2 = parseInt(values[values.length - 1], 10);

        this._searchStartPoint = {
            x: x2 + 1,
            y: y2 + 1
        };
    },

    _queueHighlight: function (wordIndex) {
        if (wordIndex === this._lastHighlightIndex) {
            return;
        }

        this._pendingHighlightIndex = wordIndex;
        if (this._highlightTimer) {
            clearTimeout(this._highlightTimer);
        }

        var that = this;
        this._highlightTimer = setTimeout(function () {
            that._highlightTimer = null;
            that._highlightWord(wordIndex);
        }, this._highlightDebounceMs);
    },

    _highlightWord: function (wordIndex) {
        if (wordIndex < 0 || wordIndex >= this._wordMetadata.length) {
            return;
        }

        var bookmarkName = this._bookmarksCreated[wordIndex];
        if (!bookmarkName) {
            this._clearHighlight();
            this._lastHighlightIndex = -1;
            console.warn('WordMeta: No bookmark for word index ' + wordIndex);
            return;
        }

        this._lastHighlightIndex = wordIndex;
        this._highlightBookmark(wordIndex, bookmarkName);
    },

    _highlightBookmark: function (wordIndex, bookmarkName) {
        var word = this._wordMetadata[wordIndex];
        if (!word || !word.word) {
            return;
        }

        this._log('debug', 'WordMeta: Highlighting word index ' + wordIndex + ' via bookmark ' + bookmarkName);
        this._clearHighlight();
        var params = {
            'Bookmark': {
                'type': 'string',
                'value': bookmarkName
            }
        };

        this._pauseIndexing();
        this._highlightSearchActive = true;
        this.map.sendUnoCommand('.uno:JumpToMark', params, true);

        var that = this;
        setTimeout(function () {
            that.map.sendUnoCommand('.uno:SelectWord', null, true);
            setTimeout(function () {
                if (that._hasTextSelection()) {
                    that._highlightSearchActive = false;
                    that._hasActiveHighlight = true;
                    that._resumeIndexing();
                    return;
                }

                var startPoint = that._getCursorSearchStartPoint();
                that._searchForHighlight(word.word, startPoint).then(function () {
                    that._highlightSearchActive = false;
                    that._hasActiveHighlight = true;
                    that._resumeIndexing();
                });
            }, that._highlightJumpDelayMs);
        }, this._highlightJumpDelayMs);
    },

    _searchForHighlight: function (wordText, startPoint) {
        var that = this;
        var token = this._highlightSearchToken + 1;
        this._highlightSearchToken = token;

        return new Promise(function (resolve) {
            var resolved = false;

            var onSearch = function (event) {
                if (token !== that._highlightSearchToken) {
                    return;
                }
                if (event.originalPhrase !== wordText) {
                    return;
                }

                resolved = true;
                that.map.off('search', onSearch, that);
                resolve(event);
            };

            that.map.on('search', onSearch, that);
            that._executeSearch(wordText, startPoint);

            setTimeout(function () {
                if (resolved) {
                    return;
                }
                that.map.off('search', onSearch, that);
                resolve(null);
            }, that._highlightSearchTimeoutMs);
        });
    },

    _getCursorSearchStartPoint: function () {
        if (app && app.file && app.file.textCursor && app.file.textCursor.rectangle) {
            return {
                x: app.file.textCursor.rectangle.x1,
                y: app.file.textCursor.rectangle.y1
            };
        }
        return this._getSearchStartPoint();
    },

    _clearHighlight: function () {
        if (!this._hasActiveHighlight) {
            return;
        }
        if (app && app.searchService && typeof app.searchService.resetSelection === 'function') {
            app.searchService.resetSelection();
        } else if (app && app.activeDocument && app.activeDocument.activeView) {
            app.activeDocument.activeView.clearTextSelection();
        }
        this._hasActiveHighlight = false;
    },

    _hasTextSelection: function () {
        return !!(app && app.activeDocument && app.activeDocument.activeView && app.activeDocument.activeView.hasTextSelection);
    },

    _pauseIndexing: function () {
        this._indexingPaused = true;
    },

    _resumeIndexing: function () {
        if (!this._indexingPaused) {
            return;
        }
        this._indexingPaused = false;
        if (this._indexingActive) {
            this._scheduleIndexingBatch(this._indexingToken);
        }
    },

    _emitIndexReady: function () {
        if (!this.map) {
            return;
        }

        var missingCount = Math.max(0, this._indexingTargetCount - this._indexingDoneCount);
        this._log('debug', 'WordMeta: Index ready. indexed=' + this._indexingDoneCount + ' missing=' + missingCount);
        this.map.fire('wordmetaindexready', {
            wordCount: this._wordMetadata.length,
            indexedCount: this._indexingDoneCount,
            missingCount: missingCount
        });
    },

    _log: function (level, message) {
        if (app && app.console && typeof app.console[level] === 'function') {
            app.console[level](message);
            return;
        }
        if (console && typeof console[level] === 'function') {
            console[level](message);
        } else {
            console.log(message);
        }
    }
});

// Register the control
window.L.control.wordMeta = function (options) {
    return new window.L.Control.WordMeta(options);
};
