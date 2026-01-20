console.log("🟢 [CUSTOM MOUNT] WriterTileLayer.js loaded successfully!");
/* -*- js-indent-level: 8 -*- */
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
 * Writer tile layer is used to display a text document
 */

/* global app GraphicSelection cool TileManager */
window.L.WriterTileLayer = window.L.CanvasTileLayer.extend({

	newAnnotation: function (commentData) {
		// Access cool namespace defensively
		var coolNS = window.cool || (typeof cool !== 'undefined' ? cool : null);
		if (!coolNS || !coolNS.Comment) {
			console.warn('[WriterTileLayer] cool.Comment not available');
			return;
		}
		const name = coolNS.Comment.makeName(commentData);
		const comment = new coolNS.Comment(name, commentData, {}, app.sectionContainer.getSectionWithName(app.CSections.CommentList.name));

		if (app.file.textCursor.visible) {
			comment.sectionProperties.data.anchorPos = [app.file.textCursor.rectangle.x2, app.file.textCursor.rectangle.y1];
		} else if (GraphicSelection.hasActiveSelection()) {
			// An image is selected, then guess the anchor based on the graphic selection.
			comment.sectionProperties.data.anchorPos = [GraphicSelection.rectangle.x1, GraphicSelection.rectangle.y2];
		}

		app.sectionContainer.getSectionWithName(app.CSections.CommentList.name).add(comment);
		app.sectionContainer.getSectionWithName(app.CSections.CommentList.name).modify(comment);
	},

	beforeAdd: function (map) {
		map.uiManager.initializeSpecializedUI('text');
	},

	_onCommandValuesMsg: function (textMsg) {
		var braceIndex = textMsg.indexOf('{');
		if (braceIndex < 0) {
			return;
		}

		var values = JSON.parse(textMsg.substring(braceIndex));
		if (!values) {
			return;
		}

		if (values.comments) {
			values.comments.forEach(function(comment) {
				comment.id = comment.id.toString();
				comment.parent = comment.parentId.toString();
			});
			app.sectionContainer.getSectionWithName(app.CSections.CommentList.name).importComments(values.comments);
			app.map.fire('importannotations');
		}
		else if (values.redlines && values.redlines.length > 0) {
			app.sectionContainer.getSectionWithName(app.CSections.CommentList.name).importChanges(values.redlines);
		}
		else if (this._map.zotero && values.userDefinedProperties) {
			this._map.zotero.handleCustomProperty(values.userDefinedProperties);
		}
		else if (this._map.zotero && values.fields) {
			this._map.zotero.onFieldValue(values.fields);
		} else if (this._map.zotero && values.field) {
			this._map.zotero.handleFieldUnderCursor(values.field);
		} else if (this._map.zotero && values.setRefs) {
			this._map.zotero.onFieldValue(values.setRefs);
		} else if (this._map.zotero && values.setRef) {
			this._map.zotero.handleFieldUnderCursor(values.setRef);
		} else if (values.bookmarks) {
			var handled = false;
			if (this._map.wordMeta) {
				handled = this._map.wordMeta.handleBookmarks(values.bookmarks) || handled;
			}
			if (this._map.zotero && !handled) {
				this._map.zotero.handleBookmark(values.bookmarks);
			}
		} else if (this._map.zotero && values.bookmark) {
			this._map.zotero.fetchCustomProperty(values.bookmark.name);
		} else if (this._map.zotero && values.sections) {
			this._map.zotero.onFieldValue(values.sections);
		} else {
			window.L.CanvasTileLayer.prototype._onCommandValuesMsg.call(this, textMsg);
		}
	},

	_onSetPartMsg: function (textMsg) {
		var part = parseInt(textMsg.match(/\d+/g)[0]);
		if (part !== this._currentPage) {
			this._currentPage = part;
			this._map.fire('pagenumberchanged', {
				currentPage: part,
				pages: this._pages,
				docType: this._docType
			});
		}
	},

	_onStatusMsg: function (textMsg) {
		const statusJSON = JSON.parse(textMsg.replace('status:', '').replace('statusupdate:', ''));

		if (app.socket._reconnecting) {
			// persist cursor position on reconnection
			// In writer, core always sends the cursor coordinates
			// of the first paragraph of the document so we want to ignore that
			// to eliminate document jumping while reconnecting
			this.persistCursorPositionInWriter = true;
			this._postMouseEvent('buttondown', this.lastCursorPos.center[0], this.lastCursorPos.center[1], 1, 1, 0);
			this._postMouseEvent('buttonup', this.lastCursorPos.center[0], this.lastCursorPos.center[1], 1, 1, 0);
		}
		if (!statusJSON.width || !statusJSON.height || this._documentInfo === textMsg)
			return;

		// Defensive: handle case where fileSize might not be initialized yet
		var currentFileSize = app.activeDocument.fileSize;
		var sizeChanged = !currentFileSize || statusJSON.width !== currentFileSize.x || statusJSON.height !== currentFileSize.y;

		if (statusJSON.viewid !== undefined) {
			this._viewId = statusJSON.viewid;
			app.activeDocument.setActiveViewID(this._viewId);
		}

		console.assert(this._viewId >= 0, 'Incorrect viewId received: ' + this._viewId);

		// Get cool.SimplePoint - try global cool first (TypeScript compiled), then window.cool
		var SimplePoint = (typeof cool !== 'undefined' && cool.SimplePoint) || (window.cool && window.cool.SimplePoint);
		var existingFileSize = app.activeDocument.fileSize;
		if (!SimplePoint && existingFileSize && existingFileSize.constructor) {
			SimplePoint = existingFileSize.constructor;
		}
		if (sizeChanged) {
			if (SimplePoint) {
				app.activeDocument.fileSize = new SimplePoint(statusJSON.width, statusJSON.height);
			} else if (existingFileSize) {
				existingFileSize.x = statusJSON.width;
				existingFileSize.y = statusJSON.height;
				app.activeDocument.fileSize = existingFileSize;
			} else {
				// Last resort: create a minimal size object to prevent blank document
				console.warn('[WriterTileLayer] SimplePoint not available, using fallback object');
				app.activeDocument.fileSize = {
					x: statusJSON.width,
					y: statusJSON.height,
					clone: function() { return { x: this.x, y: this.y, clone: this.clone }; }
				};
			}
			app.activeDocument.activeLayout.viewSize = app.activeDocument.fileSize.clone();

			this._docType = statusJSON.type;
			this._updateMaxBounds(true);
		}

		this._documentInfo = textMsg;
		this._selectedPart = 0;
		this._selectedMode = (statusJSON.mode !== undefined) ? statusJSON.mode : 0;
		this._parts = 1;
		this._currentPage = statusJSON.selectedpart;
		this._pages = statusJSON.partscount;
		app.file.writer.pageRectangleList = statusJSON.pagerectangles.slice(); // Copy the array.
		this._map.fire('pagenumberchanged', {
			currentPage: this._currentPage,
			pages: this._pages,
			docType: this._docType
		});
		// TileManager may be defined as window.TileManager or as a global
		var TileMgr = window.TileManager || (typeof TileManager !== 'undefined' ? TileManager : null);
		if (TileMgr && TileMgr.resetPreFetching) {
			TileMgr.resetPreFetching(true);
		}
	},
});
