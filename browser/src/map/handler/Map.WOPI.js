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
 * L.WOPI contains WOPI related logic
 */

console.log("🟢 [CUSTOM MOUNT] Map.WOPI.js loaded - overriding bundled WOPI handler");

/* global _ app _UNO JSDialog errorMessages URLPopUpSection */
window.L.Map.WOPI = window.L.Handler.extend({
	// If the CheckFileInfo call fails on server side, we won't have any PostMessageOrigin.
	// So use '*' because we still needs to send 'close' message to the parent frame which
	// wouldn't be possible otherwise.
	PostMessageOrigin: window.postmessageOriginExt || '*',
	BaseFileName: '',
	BreadcrumbDocName: '',
	DocumentLoadedTime: false,
	HidePrintOption: false,
	HideSaveOption: false,
	HideExportOption: false,
	HideRepairOption: false,
	HideChangeTrackingControls: false,
	DisablePrint: false,
	DisableExport: false,
	DisableCopy: false,
	DisableInactiveMessages: false,
	DownloadAsPostMessage: false,
	UserCanNotWriteRelative: true,
	EnableInsertRemoteImage: false,
	EnableInsertRemoteFile: false, /* Separate, because requires explicit integration support */
	DisableInsertLocalImage: false,
	EnableInsertRemoteLink: false,
	EnableRemoteAIContent: false,
	EnableShare: false,
	HideUserList: null,
	CallPythonScriptSource: null,
	SupportsRename: false,
	UserCanRename: false,
	UserCanWrite: false,
	DisablePresentation: false,
	PresentationLeader: '',

	_appLoadedConditions: {
		docloaded: false,
		updatepermission: false,
		viewinfo: false, /* Whether view information has already arrived */
		initializedui: false,
	},

	_appLoaded: false,
	_insertImageMenuSetupDone: false,

	initialize: function (map) {
		this._map = map;
		if (!this._map._hotkeyMode) {
			this._map._hotkeyMode = { enabled: false, hotkeys: {} };
		}
		if (!this._map._speakerIndent) {
			this._map._speakerIndent = null;
		}
	},

	addHooks: function () {
		this._map.on('postMessage', this._postMessage, this);
		this._map.on('wordmetaindexready', this._onWordMetaIndexReady, this);

		// init messages
		this._map.on('docloaded', this._postLoaded, this);
		app.events.on('updatepermission', this._postLoaded.bind(this));
		// This indicates that 'viewinfo' message has already arrived
		this._map.on('viewinfo', this._postLoaded, this);
		this._map.on('initializedui', this._postLoaded, this);

		this._map.on('wopiprops', this._setWopiProps, this);
		window.L.DomEvent.on(window, 'message', this._postMessageListener, this);

		this._map.on('updateviewslist', function () { this._postViewsMessage('Views_List'); }, this);

		// Document-level hotkey interceptor - captures keys before TextInput gets them
		var that = this;
		this._hotkeyInterceptor = function (ev) {
			var hotkeyMode = that._map && that._map._hotkeyMode;
			if (!hotkeyMode || !hotkeyMode.enabled) return;

			var key = (ev.key && ev.key.length === 1) ? ev.key.toLowerCase() : '';
			if (key && hotkeyMode.hotkeys && hotkeyMode.hotkeys[key]) {
				console.log('[Map.WOPI] Hotkey intercepted:', key);
				ev.preventDefault();
				ev.stopPropagation();
				ev.stopImmediatePropagation();
				that._map.fire('postMessage', { msgId: 'Hotkey_Pressed', args: { key: key } });
				return false;
			}
			if (ev.key === 'Escape') {
				console.log('[Map.WOPI] Escape pressed, exiting hotkey mode');
				ev.preventDefault();
				ev.stopPropagation();
				that._map.fire('postMessage', { msgId: 'Hotkey_Mode_Exit', args: {} });
				return false;
			}
		};
		// Use capture phase to intercept before bubbling to TextInput
		document.addEventListener('keydown', this._hotkeyInterceptor, true);

		if (!window.ThisIsAMobileApp) {
			// override the window.open to issue a postMessage, so that
			// it is possible to handle the hyperlink in the integration
			var that = this;
			window.open = function (open) {
				return function (url, name, features) {
					const eSignature = that._map.eSignature;
					const eSignInProgress = eSignature && eSignature.signInProgress;
					if (eSignInProgress) {
						return open.call(window, url, name, features);
					}

					that._map.fire('postMessage', {
						msgId: 'UI_Hyperlink',
						args: {
							Url: url,
							Name: name,
							Features: features
						}
					});
					if (!that._map._disableDefaultAction['UI_Hyperlink'])
						return open.call(window, url, name, features);
					else
						return null;
				};
			}(window.open);
		}
	},

	removeHooks: function () {
		this._map.off('postMessage', this._postMessage, this);
		this._map.off('wordmetaindexready', this._onWordMetaIndexReady, this);

		// init messages
		this._map.off('docloaded', this._postLoaded, this);
		this._map.off('viewinfo', this._postLoaded, this);

		this._map.off('wopiprops', this._setWopiProps, this);
		window.L.DomEvent.off(window, 'message', this._postMessageListener, this);

		this._map.off('updateviewslist');

		// Remove hotkey interceptor
		if (this._hotkeyInterceptor) {
			document.removeEventListener('keydown', this._hotkeyInterceptor, true);
			this._hotkeyInterceptor = null;
		}
	},

	// Return whether there is the capability to rename, not the permission.
	// Since we fall back on Save As for rename isn't supported.
	_supportsRename: function () {
		return !!this.SupportsRename || !this.UserCanNotWriteRelative;
	},

	_setWopiProps: function (wopiInfo) {
		var overridenFileInfo = window.checkFileInfoOverride;
		// Store postmessageorigin property, if it exists
		if (wopiInfo['PostMessageOrigin']) {
			this.PostMessageOrigin = wopiInfo['PostMessageOrigin'];
		}

		this.BaseFileName = wopiInfo['BaseFileName'];
		this.BreadcrumbDocName = wopiInfo['BreadcrumbDocName'];
		if (this.BreadcrumbDocName === undefined)
			this.BreadcrumbDocName = this.BaseFileName;
		this.HidePrintOption = !!wopiInfo['HidePrintOption'];
		this.HideSaveOption = !!wopiInfo['HideSaveOption'];
		this.HideExportOption = !!wopiInfo['HideExportOption'];
		this.HideRepairOption = !!wopiInfo['HideRepairOption'];
		this.HideChangeTrackingControls = !!wopiInfo['HideChangeTrackingControls'];
		this.DisablePrint = !!wopiInfo['DisablePrint'];
		this.DisableExport = !!wopiInfo['DisableExport'];
		this.DisableCopy = !!wopiInfo['DisableCopy'];
		this.DisableInactiveMessages = !!wopiInfo['DisableInactiveMessages'];
		this.DownloadAsPostMessage = Object.prototype.hasOwnProperty.call(overridenFileInfo, 'DownloadAsPostMessage') ?
			overridenFileInfo.DownloadAsPostMessage : !!wopiInfo['DownloadAsPostMessage'];
		this.UserCanNotWriteRelative = !!wopiInfo['UserCanNotWriteRelative'];
		this.EnableInsertRemoteImage = !!wopiInfo['EnableInsertRemoteImage'];
		this.EnableInsertRemoteFile = !!wopiInfo['EnableInsertRemoteFile'];
		this.DisableInsertLocalImage = !!wopiInfo['DisableInsertLocalImage'];
		this.EnableRemoteLinkPicker = !!wopiInfo['EnableRemoteLinkPicker'];
		this.EnableRemoteAIContent = !!wopiInfo['EnableRemoteAIContent'];
		this.SupportsRename = !!wopiInfo['SupportsRename'];
		this.UserCanRename = !!wopiInfo['UserCanRename'];
		this.EnableShare = !!wopiInfo['EnableShare'];
		this.UserCanWrite = !!wopiInfo['UserCanWrite'];
		this.DisablePresentation = wopiInfo['DisablePresentation'];
		this.PresentationLeader = wopiInfo['PresentationLeader'];

		if (this.UserCanWrite && !app.isReadOnly()) // There are 2 places that set the file permissions, WOPI and URI. Don't change permission if URI doesn't allow.
			app.setPermission('edit');

		this.IsOwner = !!wopiInfo['IsOwner'];

		if (wopiInfo['HideUserList'])
			this.HideUserList = wopiInfo['HideUserList'].split(',');

		this.sendFrameReady();

		if ('TemplateSaveAs' in wopiInfo) {
			this._map.showBusy(_('Creating new file from template...'), false);
			this._map.saveAs(wopiInfo['TemplateSaveAs']);
		}

		this.setupImageInsertionMenu();
	},

	sendFrameReady: function () {
		this._map.fire('postMessage', {
			msgId: 'App_LoadingStatus',
			args: {
				Status: 'Frame_Ready',
				Features: {
					VersionStates: true
				}
			}
		});
	},

	sendDocumentLoaded: function () {
		this._map.fire('postMessage', {
			msgId: 'App_LoadingStatus',
			args: {
				Status: 'Document_Loaded',
				DocumentLoadedTime: this.DocumentLoadedTime
			}
		});
	},

	setupImageInsertionMenu: function () {
		if (this._insertImageMenuSetupDone) {
			return;
		}

		if (this.DisableInsertLocalImage) {
			JSDialog.MenuDefinitions.set('InsertImageMenu', []);
			JSDialog.MenuDefinitions.set('InsertMultimediaMenu', []);
			JSDialog.MenuDefinitions.set('CompareDocumentsMenu', []);
		}

		var menuEntriesImage = JSDialog.MenuDefinitions.get('InsertImageMenu');
		var menuEntriesMultimedia = JSDialog.MenuDefinitions.get('InsertMultimediaMenu');
		var menuEntriesCompare = JSDialog.MenuDefinitions.get('CompareDocumentsMenu');

		if (this.EnableInsertRemoteImage) {
			menuEntriesImage.push({ action: 'remotegraphic', text: _UNO('.uno:InsertGraphic', '', true) });
		}

		if (this.EnableInsertRemoteFile) {
			/* Separate, because needs explicit integration support */
			menuEntriesMultimedia.push({ action: 'remotemultimedia', text: _UNO('.uno:InsertAVMedia', '', true) });

			menuEntriesCompare.push({ action: 'remotecomparedocuments', text: _UNO('.uno:CompareDocuments', '', true) });
		}

		this._insertImageMenuSetupDone = true;
	},

	resetAppLoaded: function () {
		this._appLoaded = false;
		for (var key in this._appLoadedConditions) {
			this._appLoadedConditions[key] = false;
		}
	},

	_postLoaded: function (e) {
		app.console.debug('PostMessage: _postLoaded - ' + e.type);

		if (this._appLoaded) {
			return;
		}

		if (e.type === 'docloaded') {
			// doc unloaded
			if (!e.status) {
				this._appLoadedConditions[e.type] = false;
				return;
			}

			this.DocumentLoadedTime = Date.now();
		}
		this._appLoadedConditions[e.type] = true;
		for (var key in this._appLoadedConditions) {
			if (!this._appLoadedConditions[key])
				return;
		}

		this._appLoaded = true;
		this.sendDocumentLoaded();
	},

	// Naturally we set a CSP to catch badness, but check here as well.
	// Checking whether a message came from our iframe's parents is
	// un-necessarily difficult.
	_allowMessageOrigin: function (e) {
		// e.origin === 'null' when sandboxed
		if (e.origin === 'null')
			return false;

		// cache - to avoid regexps.
		if (this._cachedGoodOrigin && this._cachedGoodOrigin === e.origin)
			return true;

		try {
			if (e.origin === window.parent.origin)
				return true;
		} catch (secErr) { // security error de-referencing window.parent.origin.
		}

		// sent from the server
		var i;
		if (!this._allowedOrigins && window.frameAncestors) {
			var ancestors = window.frameAncestors.trim().split(' ');
			this._allowedOrigins = ancestors;
			// convert to JS regexps from localhost:* to https*://localhost:.*
			for (i = 0; i < ancestors.length; i++) {
				this._allowedOrigins[i] = '(http|https)://' + ancestors[i].replace(/:\*/, ':?.*');
			}
		}

		if (this._allowedOrigins) {
			for (i = 0; i < this._allowedOrigins.length; i++) {
				if (e.origin.match(this._allowedOrigins[i])) {
					this._cachedGoodOrigin = e.origin;
					return true;
				}
			}
		}

		// chrome only
		if (window.location.ancestorOrigins &&
			window.location.ancestorOrigins.contains(e.origin)) {
			this._cachedGoodOrigin = e.origin;
			return true;
		}

		const eSignature = this._map.eSignature;
		if (eSignature && eSignature.url === e.origin) {
			// The sender is our esign popup: accept it.
			return true;
		}

		return false;
	},

	_postMessageListener: function (e) {
		if (!this._allowMessageOrigin(e)) {
			window.app.console.error('PostMessage not allowed due to incorrect origin.');
			return;
		}

		var msg;

		if (('data' in e) && Object.hasOwnProperty.call(e.data, 'MessageId')) {
			// when e.data already contains the right props, but isn't JSON (a blob is passed for ex)
			msg = e.data;
		} else if (typeof e.data === 'object') {
			// E.g. the esign popup sends us an object, no need to JSON-parse it.
			msg = e.data;
		} else {
			try {
				msg = JSON.parse(e.data);
			} catch (e) {
				window.app.console.error(e);
				return;
			}
		}

		// allow closing documents before they are completely loaded
		if (msg.MessageId === 'Close_Session') {
			app.socket.sendMessage('closedocument');
			return;
		}
		if (msg.MessageId === 'Capture_Speaker_Indent') {
			var style = null;
			var margin = null;
			var wantAuto = !!(msg.Values && msg.Values.auto);
			if (!wantAuto && this._map && this._map['stateChangeHandler']) {
				style = this._map['stateChangeHandler'].getItemValue('.uno:StyleApply');
				margin = this._map['stateChangeHandler'].getItemValue('.uno:LeftRightParaMargin');
			}
			if (wantAuto) {
				console.log('[SpeakerIndent] Starting auto speaker detection...');
				var that = this;
				var token = Date.now();
				var attempts = 0;
				var maxAttempts = 8;
				this._map._speakerIndentToken = token;
				var cleanup = function () {
					that._map.off('search', onSearch, that);
				};
				var finalize = function (s, m, autoFlag, lineText, isTimestamp, isSpeaker, lineSource, attemptCount) {
					var speakerName = extractSpeakerName(lineText);
					console.log('[SpeakerIndent] ✅ FINALIZED', {
						speakerName: speakerName,
						style: s,
						margin: m,
						lineText: lineText ? lineText.substring(0, 50) : '',
						isTimestamp: isTimestamp,
						isSpeaker: isSpeaker,
						lineSource: lineSource,
						attempts: attemptCount
					});
					that._map._speakerIndent = { style: s, margin: m };
					that._map.fire('postMessage', {
						msgId: 'Speaker_Indent_Resp',
						args: {
							style: s,
							margin: m,
							auto: autoFlag,
							lineText: lineText,
							isTimestamp: isTimestamp,
							isSpeaker: isSpeaker,
							lineSource: lineSource,
							attempts: attemptCount,
							speakerName: speakerName
						}
					});
				};
				var getSelectionLineText = function () {
					try {
						var sel = window.getSelection && window.getSelection();
						if (!sel || !sel.anchorNode) return '';
						var node = sel.anchorNode;
						if (node.nodeType === 3) node = node.parentElement || node;
						if (!node || !node.textContent) return '';
						return node.textContent;
					} catch (e) {
						return '';
					}
				};
				var getSearchResultLineText = function () {
					try {
						var map = window.L && window.L.Map && window.L.Map.THIS;
						var docLayer = map && map._docLayer;
						var res = docLayer && docLayer._lastSearchResult;
						if (!res) return '';
						var text =
							res.text ||
							res.textString ||
							res.selectedText ||
							res.selectedTextString ||
							res.searchString ||
							'';
						return text || '';
					} catch (e) {
						return '';
					}
				};
				var getClipLineText = function () {
					try {
						var cached = that._map && that._map._lastSelectionPlainText;
						if (cached) {
							return cached.replace(/\r/g, '').split('\n')[0];
						}
						var clip = that._map && that._map._clip;
						var text = clip && clip._selectionPlainTextContent ? clip._selectionPlainTextContent : '';
						if (!text) return '';
						text = text.replace(/\r/g, '').split('\n')[0];
						return text;
					} catch (e) {
						return '';
					}
				};
				var selectParagraphForSelection = function () {
					try {
						if (that._map && typeof that._map.sendUnoCommand === 'function') {
							that._map.sendUnoCommand('.uno:StartOfPara');
							that._map.sendUnoCommand('.uno:EndOfParaSel');
						}
					} catch (e) {
						// ignore
					}
				};
				var pendingTextCallback = null;
				var requestSelectionText = function (callback) {
					try {
						// Clear previous text
						if (that._map) {
							that._map._lastSelectionPlainText = '';
						}
						if (that._map && that._map._clip) {
							that._map._clip._selectionPlainTextContent = '';
						}
						console.log('[SpeakerIndent] Selecting paragraph and requesting text...');
						selectParagraphForSelection();

						// Give UNO commands time to complete before requesting text
						window.setTimeout(function () {
							console.log('[SpeakerIndent] Sending gettextselection request...');
							app.socket.sendMessage('gettextselection mimetype=text/plain;charset=utf-8');

							// Poll for the text to arrive
							var pollCount = 0;
							var maxPolls = 20; // 20 x 50ms = 1 second max wait
							var pollForText = function () {
								pollCount++;
								var text = that._map._lastSelectionPlainText || '';
								if (!text && that._map._clip) {
									text = that._map._clip._selectionPlainTextContent || '';
								}
								// Only log every 5 polls to reduce noise
								if (pollCount % 5 === 0 || pollCount === 1) {
									console.log('[SpeakerIndent] Poll ' + pollCount + '/' + maxPolls + ', text:', text ? text.substring(0, 30) : '(empty)');
								}

								if (text) {
									// Got text! Extract first line
									var firstLine = text.replace(/\r/g, '').split('\n')[0];
									console.log('[SpeakerIndent] ✓ Got text:', firstLine.substring(0, 50));
									if (callback) callback(firstLine);
								} else if (pollCount < maxPolls) {
									window.setTimeout(pollForText, 50);
								} else {
									console.log('[SpeakerIndent] ✗ Polling timed out, no text received');
									if (callback) callback('');
								}
							};
							// Start polling after a short delay
							window.setTimeout(pollForText, 100);
						}, 100);
					} catch (e) {
						console.log('[SpeakerIndent] Error in requestSelectionText:', e);
						if (callback) callback('');
					}
				};
				var getLineText = function () {
					var fromClip = getClipLineText();
					if (fromClip) return { text: fromClip, source: 'clip' };
					var fromSelection = getSelectionLineText();
					if (fromSelection) return { text: fromSelection, source: 'selection' };
					var fromSearch = getSearchResultLineText();
					if (fromSearch) return { text: fromSearch, source: 'search' };
					return { text: '', source: 'none' };
				};
				var isTimestampSelection = function (lineText) {
					if (!lineText) return false;
					return /^\s*\d{1,2}:\d{2}:\d{2}\b/.test(lineText);
				};
				var isSpeakerLine = function (lineText) {
					if (!lineText) return false;
					return /^[^a-z]*[A-Z][A-Z .]*:/.test(lineText);
				};
				var extractSpeakerName = function (lineText) {
					if (!lineText) return null;
					var match = lineText.match(/^[^a-z]*([A-Z][A-Z .]*?):/);
					return match ? match[1].trim() : null;
				};
				var advanceSearch = function () {
					if (app.searchService && typeof app.searchService.search === 'function') {
						app.searchService.search(':', false, '', 0, true);
						return true;
					}
					return false;
				};
				var processLineText = function (lineText) {
					var s = null;
					var m = null;
					if (that._map && that._map['stateChangeHandler']) {
						s = that._map['stateChangeHandler'].getItemValue('.uno:StyleApply');
						m = that._map['stateChangeHandler'].getItemValue('.uno:LeftRightParaMargin');
					}
					attempts += 1;
					var isTs = isTimestampSelection(lineText);
					var isSpeaker = isSpeakerLine(lineText);
					var speakerName = extractSpeakerName(lineText);
					console.log('[SpeakerIndent] Attempt ' + attempts + '/' + maxAttempts, {
						lineText: lineText ? lineText.substring(0, 50) : '',
						isTimestamp: isTs,
						isSpeaker: isSpeaker,
						speakerName: speakerName,
						style: s
					});

					// If we have a non-default style and found a colon via search, accept it
					// even if we couldn't get the text to verify (text retrieval is unreliable)
					if (s && s !== 'Default Paragraph Style') {
						// If we have text, verify it's not a timestamp
						if (lineText && isTs) {
							console.log('[SpeakerIndent] Skipping timestamp line, advancing search...');
							if (attempts < maxAttempts && advanceSearch()) {
								return;
							}
						} else {
							// Accept this style - either text confirms speaker or we trust the search found ':'
							console.log('[SpeakerIndent] ✅ Found valid speaker style!', { speakerName: speakerName || '(unknown)', style: s });
							cleanup();
							finalize(s, m, true, lineText, isTs, isSpeaker || !lineText, 'search', attempts);
							return;
						}
					}

					// Style is default or not available - try next search result
					if (attempts < maxAttempts && advanceSearch()) {
						console.log('[SpeakerIndent] Style is default or unavailable, advancing search...');
						return;
					}

					console.log('[SpeakerIndent] ⚠️ Max attempts reached or no valid speaker style found');
					cleanup();
					finalize(null, null, true, lineText, isTs, isSpeaker, 'search', attempts);
				};
				var onSearch = function (e) {
					if (that._map._speakerIndentToken !== token) return;
					if (!e || e.originalPhrase !== ':') return;
					console.log('[SpeakerIndent] Search found ":" match, requesting selection text...');
					requestSelectionText(function (text) {
						processLineText(text);
					});
				};
				this._map.on('search', onSearch, this);
				console.log('[SpeakerIndent] Starting document search for ":"...');
				if (app.searchService && typeof app.searchService.search === 'function') {
					app.searchService.search(':', false);
				}
				window.setTimeout(function () {
					if (that._map._speakerIndentToken !== token) return;
					cleanup();
					var lineInfo = getLineText();
					var lineText = lineInfo.text;
					var isTs = isTimestampSelection(lineText);
					var isSpeaker = isSpeakerLine(lineText);
					finalize(null, null, true, lineText, isTs, isSpeaker, lineInfo.source, attempts);
				}, 1500);
				return;
			}
			this._map._speakerIndent = { style: style, margin: margin };
			this._map.fire('postMessage', {
				msgId: 'Speaker_Indent_Resp',
				args: { style: style, margin: margin }
			});
			return;
		}
		if (msg.MessageId === 'Hotkey_Mode_Config') {
			if (!msg.Values) {
				window.app.console.error('Property "Values" not set');
				return;
			}
			var enabled = !!msg.Values.enabled;
			var hotkeys = Array.isArray(msg.Values.hotkeys) ? msg.Values.hotkeys : [];
			var hotkeyMap = {};
			for (var i = 0; i < hotkeys.length; i++) {
				var key = hotkeys[i];
				if (typeof key === 'string' && key.length) {
					hotkeyMap[key.toLowerCase()] = true;
				}
			}
			this._map._hotkeyMode = { enabled: enabled, hotkeys: hotkeyMap };
			this._map.fire('postMessage', {
				msgId: 'Hotkey_Mode_Config_Resp',
				args: { enabled: enabled, hotkeyCount: Object.keys(hotkeyMap).length }
			});
			return;
		}

		// Exception: UI modification can be done before WOPIPostmessageReady was fulfilled
		if (msg.MessageId === 'Show_Button' || msg.MessageId === 'Hide_Button' || msg.MessageId === 'Remove_Button') {
			if (!msg.Values) {
				window.app.console.error('Property "Values" not set');
				return;
			}

			if (!msg.Values.id) {
				window.app.console.error('Property "Values.id" not set');
				return;
			}
			var show = msg.MessageId === 'Show_Button';
			this._map.uiManager.showButton(msg.Values.id, show);
			return;
		}
		else if (msg.MessageId === 'Show_Command' || msg.MessageId === 'Hide_Command') {
			if (!msg.Values) {
				window.app.console.error('Property "Values" not set');
				return;
			}

			if (!msg.Values.id) {
				window.app.console.error('Property "Values.id" not set');
				return;
			}
			var show = msg.MessageId === 'Show_Command';
			this._map.uiManager.showCommand(msg.Values.id, show);
			return;
		}
		else if (msg.MessageId === 'Remove_Statusbar_Element') {
			if (!msg.Values) {
				window.app.console.error('Property "Values" not set');
				return;
			}
			if (!msg.Values.id) {
				window.app.console.error('Property "Values.id" not set');
				return;
			}
			// TODO: remove
			window.app.map.statusBar.showItem(msg.Values.id, false);
			return;
		}
		else if (msg.MessageId === 'Show_Menubar') {
			this._map.uiManager.showMenubar();
			return;
		}
		else if (msg.MessageId === 'Hide_Menubar') {
			this._map.uiManager.hideMenubar();
			return;
		}
		else if (msg.MessageId === 'Show_Ruler') {
			this._map.uiManager.showRuler();
			return;
		}
		else if (msg.MessageId === 'Hide_Ruler') {
			this._map.uiManager.hideRuler();
			return;
		}
		else if (msg.MessageId === 'Show_StatusBar') {
			this._map.uiManager.showStatusBar();
			return;
		}
		else if (msg.MessageId === 'Hide_StatusBar') {
			this._map.uiManager.hideStatusBar(false);
			return;
		}
		else if (msg.MessageId === 'Collapse_Notebookbar') {
			this._map.uiManager.collapseNotebookbar();
			return;
		}
		else if (msg.MessageId === 'Extend_Notebookbar') {
			this._map.uiManager.extendNotebookbar();
			return;
		}
		else if (msg.MessageId === 'Show_NotebookTab' || msg.MessageId === 'Hide_NotebookTab') {
			if (!msg.Values) {
				window.app.console.error('Property "Values" not set');
				return;
			}
			if (!msg.Values.id) {
				window.app.console.error('Property "Values.id" not set');
				return;
			}

			let show = msg.MessageId === 'Show_NotebookTab';
			this._map.uiManager.showNotebookTab(msg.Values.id, show);
			return;
		}
		else if (msg.MessageId === 'Show_Sidebar') {
			/* id is optional */
			if (msg.Values) {
				switch (msg.Values.id) {
					case 'Navigator':
					case 'ModifyPage':
					case 'CustomAnimation':
					case 'MasterSlidesPanel':
						this._map.sendUnoCommand(`.uno:${msg.Values.id}`);
						return;
				}
			}
			this._map.sendUnoCommand('.uno:SidebarDeck.PropertyDeck');
			return;
		}
		else if (msg.MessageId === 'Hide_Sidebar') {
			this._map.sendUnoCommand('.uno:SidebarHide');
			return;
		}
		else if (msg.MessageId === 'Show_Menu_Item' || msg.MessageId === 'Hide_Menu_Item') {
			if (!msg.Values) {
				window.app.console.error('Property "Values" not set');
				return;
			}
			if (!msg.Values.id) {
				window.app.console.error('Property "Values.id" not set');
				return;
			}
			if (!this._map.menubar || !this._map.menubar.hasItem(msg.Values.id)) {
				window.app.console.error('Menu item with id "' + msg.Values.id + '" not found.');
				if (this._map.uiManager.getCurrentMode() === 'notebookbar') {
					window.app.console.error('No menu items in notebookbar');
				}
				return;
			}

			if (msg.MessageId === 'Show_Menu_Item') {
				if (!this._map.menubar.showItem(msg.Values.id)) {
					window.app.console.error('Menu entry with id "' + msg.Values.id + '" not found.');
				}
			} else if (!this._map.menubar.hideItem(msg.Values.id)) {
				window.app.console.error('Menu entry with id "' + msg.Values.id + '" not found.');
			}
			return;
		}
		else if (msg.MessageId === 'Insert_Button' &&
			msg.Values && msg.Values.id) {
			this._map.uiManager.insertButton(msg.Values);
			return;
		}
		else if (msg.MessageId === 'Insert_ContextualButton' &&
			msg.Values && msg.Values.id) {
			this._map.uiManager.map.contextToolbar.insertAdditionalContextButton(msg.Values);
			return;
		}
		else if (msg.MessageId === 'Send_UNO_Command' && msg.Values && msg.Values.Command) {
			this._map.sendUnoCommand(msg.Values.Command, msg.Values.Args || '');
			return;
		}
		else if (msg.MessageId === 'Hint_OnscreenKeyboard') {
			window.keyboard.hintOnscreenKeyboard(true);
			return;
		}
		else if (msg.MessageId === 'Hint_NoOnscreenKeyboard') {
			window.keyboard.hintOnscreenKeyboard(false);
			return;
		}
		else if (msg.MessageId === 'Disable_Default_UIAction') {
			// Disable the default handler and action for a UI command.
			// When set to true, the given UI command will issue a postmessage
			// only. For example, UI_Save will be issued for invoking the save
			// command (from the menu, toolbar, or keyboard shortcut) and no
			// action will take place if 'UI_Save' is disabled via
			// the Disable_Default_UIAction command.
			if (msg.Values && msg.Values.action && msg.Values.disable !== undefined) {
				this._map._disableDefaultAction[msg.Values.action] = msg.Values.disable;
			}
			return;
		}
		else if (msg.MessageId === 'Error_Messages') {
			if (msg.Values && msg.Values.list) {
				msg.Values.list.forEach(function (item) {
					if (Object.prototype.hasOwnProperty.call(errorMessages.storage, item.type)) {
						errorMessages.storage[item.type] = item.msg;
					} else if (Object.prototype.hasOwnProperty.call(errorMessages.uploadfile, item.type)) {
						errorMessages.uploadfile[item.type] = item.msg;
					} else if (Object.prototype.hasOwnProperty.call(errorMessages, item.type)) {
						errorMessages[item.type] = item.msg;
					}
				});
			}
		}

		// All following actions must be done after initialization is completed.
		if (!window.WOPIPostmessageReady) {
			window.app.console.error('PostMessage ignored: not ready.');
			return;
		}

		if (msg.MessageId === 'Host_PostmessageReady') {
			// We already have a listener for this in cool.html, so ignore it here
			return;
		}

		if (msg.MessageId === 'Grab_Focus') {
			app.idleHandler._activate();
			return;
		}

		// allow closing documents before they are completely loaded
		if (msg.MessageId === 'Close_Session') {
			app.socket.sendMessage('closedocument');
			return;
		}

		// when user goes idle we have 'this._appLoaded == false'
		if (msg.MessageId === 'Get_User_State') {
			var isIdle = app.idleHandler.isDimActive();
			this._postMessage({
				msgId: 'Get_User_State_Resp', args: {
					State: (isIdle ? 'idle' : 'active'),
					Elapsed: app.idleHandler.getElapsedFromActivity()
				}
			});
		}

		// For all other messages, warn if trying to interact before we are completely loaded
		if (!this._appLoaded) {
			window.app.console.error('Collabora Online not loaded yet. Listen for App_LoadingStatus (Document_Loaded) event before using PostMessage API. Ignoring post message \'' + msg.MessageId + '\'.');
			return;
		}

		if (msg.MessageId === 'Set_Settings') {
			if (msg.Values) {
				var alwaysActive = msg.Values.AlwaysActive;
				this._map.options.alwaysActive = !!alwaysActive;
			}
		}
		else if (msg.MessageId === 'Get_Views') {
			this._postViewsMessage('Get_Views_Resp');
		}
		else if (msg.MessageId === 'Reset_Access_Token') {
			app.socket.sendMessage('resetaccesstoken ' + msg.Values.token);
		}
		else if (msg.MessageId === 'Action_Save') {
			var dontTerminateEdit = msg.Values && msg.Values['DontTerminateEdit'];
			var dontSaveIfUnmodified = msg.Values && msg.Values['DontSaveIfUnmodified'];
			var extendedData = msg.Values && msg.Values['ExtendedData'];
			extendedData = encodeURIComponent(extendedData);
			this._notifySave = msg.Values && msg.Values['Notify'];

			this._map.save(dontTerminateEdit, dontSaveIfUnmodified, extendedData);
		}
		else if (msg.MessageId === 'Action_Close') {
			this._map.remove();
		}
		else if (msg.MessageId === 'Action_Fullscreen') {
			app.util.toggleFullScreen();
		}
		else if (msg.MessageId === 'Action_FullscreenPresentation' && this._map.getDocType() === 'presentation') {
			if (msg.Values) {
				var slideNumber;
				if (typeof msg.Values.StartSlideNumber != 'undefined') {
					slideNumber = msg.Values.StartSlideNumber;
				} else if (msg.Values.CurrentSlide) {
					slideNumber = this._map.getCurrentPartNumber();
				}
				this._map.fire('fullscreen',
					{
						startSlideNumber: slideNumber
					});
			} else {
				this._map.fire('fullscreen');
			}
		}
		else if (msg.MessageId === 'Action_Print') {
			this._map.print();
		}
		else if (msg.MessageId === 'Action_Export') {
			if (msg.Values) {
				this._notifySave = msg.Values['Notify'];
				var format = msg.Values.Format;
				var fileName = this._map['wopi'].BaseFileName;
				fileName = fileName.substr(0, fileName.lastIndexOf('.'));
				fileName = fileName === '' ? 'document' : fileName;
				this._map.downloadAs(fileName + '.' + format, format);
			}
		}
		else if (msg.MessageId == 'Action_InsertGraphic') {
			if (msg.Values) {
				this._map.insertURL(msg.Values.url, "graphicurl");
			}
		}
		else if (msg.MessageId == 'Action_InsertMultimedia') {
			if (msg.Values) {
				this._map.insertURL(msg.Values.url, "multimediaurl");
			}
		}
		else if (msg.MessageId == 'Action_CompareDocuments') {
			if (msg.Values) {
				this._map.insertURL(msg.Values.url, "comparedocumentsurl");
			}
		}
		else if (msg.MessageId == 'Action_InsertLink') {
			if (msg.Values) {
				var link = this._map.makeURLFromStr(msg.Values.url);
				var text = this._map.getTextForLink();

				text = text ? text.trim() : link;

				var command = {
					'Hyperlink.Text': {
						type: 'string',
						value: text
					},
					'Hyperlink.URL': {
						type: 'string',
						value: link
					}
				};
				this._map.sendUnoCommand('.uno:SetHyperlink', command);
				this._map.focus();
			}
		}
		else if (msg.MessageId == 'Action_GetLinkPreview_Resp') {
			var preview = document.querySelector('#hyperlink-pop-up-preview');
			if (preview) {
				// check if this is a preview for currently displayed link
				if (preview.nextSibling && preview.nextSibling.innerText !== msg.Values.url)
					return;

				preview.innerText = '';
				if (msg.Values.image && msg.Values.image.indexOf('data:') === 0) {
					var image = window.L.DomUtil.create('img', '', preview);
					image.src = msg.Values.image;
					image.alt = msg.Values.title;
					image.onload = function () {
						URLPopUpSection.resetPosition();
					};
				} else {
					window.L.DomUtil.addClass(preview, 'no-preview');
				}
				if (msg.Values.title) {
					var title = window.L.DomUtil.create('p', '', preview);
					title.innerText = msg.Values.title;
					URLPopUpSection.resetPosition();
				}
			}
		}
		else if (msg.MessageId === 'Action_InsertFile') {
			if (msg.Values && (msg.Values.File instanceof Blob)) {
				this._map.fire('insertfile', { file: msg.Values.File });
			}
		}
		else if (msg.MessageId == 'Action_Paste') {
			if (msg.Values && msg.Values.Mimetype && msg.Values.Data) {
				var blob = new Blob(['paste mimetype=' + msg.Values.Mimetype + '\n', msg.Values.Data]);
				app.socket.sendMessage(blob);
			}
		}
		else if (msg.MessageId == 'Action_Copy') {
			// Request the current text selection in some format.
			if (msg.Values && msg.Values.Mimetype && this._map._clip) {
				this._map._clip.setActionCopy(true);
				app.socket.sendMessage('gettextselection mimetype=' + msg.Values.Mimetype);
			}
		}
		else if (msg.MessageId === 'Action_ShowBusy') {
			if (msg.Values && msg.Values.Label) {
				this._map.fire('showbusy', { label: msg.Values.Label });
			}
		}
		else if (msg.MessageId === 'Action_HideBusy') {
			this._map.fire('hidebusy');
		}
		else if (msg.MessageId === 'Get_Export_Formats') {
			var exportFormatsResp = [];
			for (var index in app.file.exportFormats) {
				exportFormatsResp.push({
					Label: app.file.exportFormats[index].label,
					Format: app.file.exportFormats[index].format
				});
			}

			this._postMessage({ msgId: 'Get_Export_Formats_Resp', args: exportFormatsResp });
		}
		else if (msg.MessageId === 'Action_SaveAs') {
			if (msg.Values) {
				if (msg.Values.Filename !== null && msg.Values.Filename !== undefined) {
					this._notifySave = msg.Values['Notify'];
					var nameParts = msg.Values.Filename.split('.');
					var format = undefined;
					if (nameParts.length > 1)
						format = nameParts.pop();
					else {
						this._map.uiManager.showInfoModal('error', _('Error'), _('File name should contain an extension.'), '', _('OK'));
						return;
					}

					var isExport = format === 'pdf' || format === 'epub';
					if (isExport) {
						this._map.exportAs(msg.Values.Filename);
					} else {
						this._map.showBusy(_('Creating copy...'), false);
						this._map.saveAs(msg.Values.Filename, format);
					}
				}
			}
		}
		else if (msg.MessageId === 'Action_FollowUser') {
			if (msg.Values) {
				this._map._setFollowing(msg.Values.Follow, msg.Values.ViewId);
			}
			else {
				this._map._setFollowing(true, null);
			}
		}
		else if (msg.MessageId === 'Host_VersionRestore') {
			if (msg.Values.Status === 'Pre_Restore') {
				app.socket.sendMessage('versionrestore prerestore');
			}
		}
		else if (msg.MessageId === 'CallPythonScript' &&
			Object.prototype.hasOwnProperty.call(msg, 'ScriptFile') &&
			Object.prototype.hasOwnProperty.call(msg, 'Function')) {
			this._map.CallPythonScriptSource = e.source;
			this._map.sendUnoCommand('vnd.sun.star.script:' + msg.ScriptFile + '$' + msg.Function + '?language=Python&location=share', msg.Values);
		}
		else if (msg.MessageId === 'Action_RemoveView') {
			if (msg.Values && msg.Values.ViewId !== null && msg.Values.ViewId !== undefined) {
				app.socket.sendMessage('removesession ' + msg.Values.ViewId);
			}
		}
		else if (msg.MessageId === 'Action_ChangeUIMode') {
			this._map.uiManager.onChangeUIMode({ mode: msg.Values.Mode, force: true });
		}
		else if (msg.MessageId === 'Action_Mention') {
			var list = msg.Values.list;
			this._map.mention.openMentionPopup(list);
		}
		else if (msg.sender === 'EIDEASY_SINGLE_METHOD_SIGNATURE') {
			// This is produced by the esign popup.
			const eSignature = this._map.eSignature;
			if (eSignature) {
				eSignature.handleSigned(msg);
			}
		}
		// WordMeta: Import word metadata from JSON
		// Format: { MessageId: 'Import_WordMeta', Values: { words: [{word, start, end, confidence}, ...] } }
		else if (msg.MessageId === 'Import_WordMeta') {
			if (msg.Values && msg.Values.words && this._map.wordMeta) {
				var success = this._map.wordMeta.importFromJSON(msg.Values.words);
				this._postMessage({
					msgId: 'Import_WordMeta_Resp',
					args: {
						success: success,
						wordCount: success ? this._map.wordMeta.getWordCount() : 0
					}
				});
			} else {
				this._postMessage({
					msgId: 'Import_WordMeta_Resp',
					args: { success: false, error: 'WordMeta not available or invalid data' }
				});
			}
		}
		// WordMeta: Get metadata for a specific word
		// Format: { MessageId: 'Get_WordMeta', Values: { index: 0 } }
		else if (msg.MessageId === 'Get_WordMeta') {
			if (msg.Values && this._map.wordMeta) {
				var meta = this._map.wordMeta.getWordMeta(msg.Values.index);
				this._postMessage({
					msgId: 'Get_WordMeta_Resp',
					args: { index: msg.Values.index, metadata: meta }
				});
			}
		}
		// WordMeta: Navigate to word at timestamp
		// Format: { MessageId: 'Navigate_WordTime', Values: { time: 30.5 } }
		else if (msg.MessageId === 'Navigate_WordTime') {
			if (msg.Values && this._map.wordMeta) {
				var wordIndex = this._map.wordMeta.findWordByTime(msg.Values.time);
				var hasBookmark = wordIndex >= 0 && this._map.wordMeta.hasBookmark(wordIndex);
				if (hasBookmark) {
					this._map.wordMeta.navigateToWord(wordIndex);
				}
				this._postMessage({
					msgId: 'Navigate_WordTime_Resp',
					args: {
						time: msg.Values.time,
						wordIndex: wordIndex,
						found: wordIndex >= 0,
						hasBookmark: hasBookmark
					}
				});
			}
		}
		// WordMeta: Get all paragraph first words with timestamps
		// Format: { MessageId: 'Get_ParagraphFirstWords' }
		else if (msg.MessageId === 'Get_ParagraphFirstWords') {
			if (this._map.wordMeta) {
				var stats = this._map.wordMeta.getParagraphStats();
				var firstWords = this._map.wordMeta.getAllParagraphFirstWords();
				this._postMessage({
					msgId: 'Get_ParagraphFirstWords_Resp',
					args: {
						paragraphs: firstWords,
						totalParagraphs: stats.totalParagraphs,
						paragraphsWithTimestamps: stats.paragraphsWithTimestamps,
						paragraphsSkipped: stats.paragraphsSkipped
					}
				});
			} else {
				this._postMessage({
					msgId: 'Get_ParagraphFirstWords_Resp',
					args: { error: 'WordMeta not available' }
				});
			}
		}
		// WordMeta: Toggle audio playback mode (controls paragraph markers)
		// Format: { MessageId: 'Audio_Playback_Mode', Values: { enabled: true/false } }
		else if (msg.MessageId === 'Audio_Playback_Mode') {
			var enabled = msg.Values && msg.Values.enabled === true;
			console.log('[Map.WOPI] Audio_Playback_Mode:', enabled);
			if (this._map.wordMeta) {
				this._map.wordMeta.setAudioPlaybackMode(enabled);
				this._postMessage({
					msgId: 'Audio_Playback_Mode_Resp',
					args: { enabled: enabled, success: true }
				});
			} else {
				this._postMessage({
					msgId: 'Audio_Playback_Mode_Resp',
					args: { enabled: enabled, success: false, error: 'WordMeta not available' }
				});
			}
		}
	},

	_onWordMetaIndexReady: function (e) {
		this._postMessage({
			msgId: 'WordMeta_IndexReady',
			args: {
				wordCount: e.wordCount,
				indexedCount: e.indexedCount,
				missingCount: e.missingCount
			}
		});
	},

	_postMessage: function (e) {
		if (!this.enabled) { return; }
		var msgId = e.msgId;
		var values = e.args || {};
		if (!!this.PostMessageOrigin && window.parent !== window.self) {
			// Filter out unwanted save request response
			if (msgId === 'Action_Save_Resp') {
				if (!this._notifySave)
					return;

				this._notifySave = false;
			}

			var msg = {
				'MessageId': msgId,
				'SendTime': Date.now(),
				'Values': values
			};
			window.parent.postMessage(JSON.stringify(msg), this.PostMessageOrigin);
		}
	},

	_postViewsMessage: function (messageId) {
		var getMembersRespVal = [];
		for (var viewInfoIdx in this._map._viewInfo) {
			getMembersRespVal.push({
				ViewId: viewInfoIdx,
				UserName: this._map._viewInfo[viewInfoIdx].username,
				UserId: this._map._viewInfo[viewInfoIdx].userid,
				UserExtraInfo: this._map._viewInfo[viewInfoIdx].userextrainfo,
				Color: this._map._viewInfo[viewInfoIdx].color,
				ReadOnly: this._map._viewInfo[viewInfoIdx].readonly,
				IsCurrentView: this._map._docLayer._viewId === parseInt(viewInfoIdx, 10)
			});
		}

		this._postMessage({ msgId: messageId, args: getMembersRespVal });
	}
});

// This handler would only get 'enabled' by map if map.options.wopi = true
window.L.Map.addInitHook('addHandler', 'wopi', window.L.Map.WOPI);

// Re-register on existing map if it exists (for custom script override after bundle.js)
(function () {
	var existingMap = window.L && window.L.Map && window.L.Map.THIS;
	if (existingMap && existingMap.wopi) {
		console.log('[Map.WOPI] Replacing existing WOPI handler on map...');
		// Disable old handler
		if (existingMap.wopi.disable) {
			existingMap.wopi.disable();
		}
		// Remove old handler
		delete existingMap.wopi;
		// Create and enable new handler
		existingMap.wopi = new window.L.Map.WOPI(existingMap);
		if (existingMap.options && existingMap.options.wopi) {
			existingMap.wopi.enable();
		}
		console.log('[Map.WOPI] WOPI handler replaced successfully!');
	} else {
		console.log('[Map.WOPI] No existing map found, handler will be added via addInitHook');
	}
})();
