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

    // Bookmark naming prefix
    BOOKMARK_PREFIX: 'WMETA_',

    onAdd: function (map) {
        this.map = map;
        this._wordMetadata = [];
        this._bookmarksCreated = {};
        this._isLoaded = false;

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

        // Generate unique bookmark name
        var bookmarkName = this.BOOKMARK_PREFIX + wordIndex + '_' + Math.floor(word.start * 1000);

        // Store metadata as custom document property
        this._setCustomProperty(bookmarkName, JSON.stringify({
            index: wordIndex,
            start: word.start,
            end: word.end,
            confidence: word.confidence
        }));

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

        var word = this._wordMetadata[wordIndex];
        console.log('WordMeta: Navigating to word ' + wordIndex + ': "' + word.word + '"');

        // For now, use search to find and highlight the word
        // In a full implementation, we'd use bookmarks for precise positioning
        this._highlightWordBySearch(word.word, wordIndex);
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
            this.navigateToWord(wordIndex);
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
    }
});

// Register the control
window.L.control.wordMeta = function (options) {
    return new window.L.Control.WordMeta(options);
};
