/**
 * The constructor for a CometD object, identified by an optional name.
 * The default name is the string 'default'.
 * In the rare case a page needs more than one Bayeux conversation,
 * a new instance can be created via:
 * <pre>
 * var bayeuxUrl2 = ...;
 *
 * // Dojo style
 * var cometd2 = new dojox.CometD('another_optional_name');
 *
 * // jQuery style
 * var cometd2 = new $.CometD('another_optional_name');
 *
 * cometd2.init({url: bayeuxUrl2});
 * </pre>
 * @param name the optional name of this cometd object
 */
// IMPLEMENTATION NOTES:
// Be very careful in not changing the function order and pass this file every time through JSLint (http://jslint.com)
// The only implied globals must be "dojo", "org" and "window", and check that there are no "unused" warnings
// Failing to pass JSLint may result in shrinkers/minifiers to create an unusable file.
org.cometd.CometD = function(name) {
    var _cometd = this;
    var _name = name || 'default';
    var _crossDomain = false;
    var _transports = new org.cometd.TransportRegistry();
    var _transport;
    var _status = 'disconnected';
    var _messageId = 0;
    var _clientId = null;
    var _batch = 0;
    var _messageQueue = [];
    var _internalBatch = false;
    var _listeners = {};
    var _backoff = 0;
    var _scheduledSend = null;
    var _extensions = [];
    var _advice = {};
    var _handshakeProps;
    var _handshakeCallback;
    var _callbacks = {};
    var _remoteCalls = {};
    var _reestablish = false;
    var _connected = false;
    var _unconnectTime = 0;
    var _config = {
        protocol: null,
        stickyReconnect: true,
        connectTimeout: 0,
        maxConnections: 2,
        backoffIncrement: 1000,
        maxBackoff: 60000,
        logLevel: 'info',
        reverseIncomingExtensions: true,
        maxNetworkDelay: 10000,
        requestHeaders: {},
        appendMessageTypeToURL: true,
        autoBatch: false,
        urls: {},
        maxURILength: 2000,
        advice: {
            timeout: 60000,
            interval: 0,
            reconnect: 'retry',
            maxInterval: 0
        }
    };

    function _fieldValue(object, name) {
        try {
            return object[name];
        } catch (x) {
            return undefined;
        }
    }

    /**
     * Mixes in the given objects into the target object by copying the properties.
     * @param deep if the copy must be deep
     * @param target the target object
     * @param objects the objects whose properties are copied into the target
     */
    this._mixin = function(deep, target, objects) {
        var result = target || {};

        // Skip first 2 parameters (deep and target), and loop over the others
        for (var i = 2; i < arguments.length; ++i) {
            var object = arguments[i];

            if (object === undefined || object === null) {
                continue;
            }

            for (var propName in object) {
                if (object.hasOwnProperty(propName)) {
                    var prop = _fieldValue(object, propName);
                    var targ = _fieldValue(result, propName);

                    // Avoid infinite loops
                    if (prop === target) {
                        continue;
                    }
                    // Do not mixin undefined values
                    if (prop === undefined) {
                        continue;
                    }

                    if (deep && typeof prop === 'object' && prop !== null) {
                        if (prop instanceof Array) {
                            result[propName] = this._mixin(deep, targ instanceof Array ? targ : [], prop);
                        } else {
                            var source = typeof targ === 'object' && !(targ instanceof Array) ? targ : {};
                            result[propName] = this._mixin(deep, source, prop);
                        }
                    } else {
                        result[propName] = prop;
                    }
                }
            }
        }

        return result;
    };

    function _isString(value) {
        return org.cometd.Utils.isString(value);
    }

    function _isFunction(value) {
        if (value === undefined || value === null) {
            return false;
        }
        return typeof value === 'function';
    }

    function _zeroPad(value, length) {
        var result = '';
        while (--length > 0) {
            if (value >= Math.pow(10, length)) {
                break;
            }
            result += '0';
        }
        result += value;
        return result;
    }

    function _log(level, args) {
        if (window.console) {
            var logger = window.console[level];
            if (_isFunction(logger)) {
                var now = new Date();
                [].splice.call(args, 0, 0, _zeroPad(now.getHours(), 2) + ':' + _zeroPad(now.getMinutes(), 2) + ':' +
                        _zeroPad(now.getSeconds(), 2) + '.' + _zeroPad(now.getMilliseconds(), 3));
                logger.apply(window.console, args);
            }
        }
    }

    this._warn = function() {
        _log('warn', arguments);
    };

    this._info = function() {
        if (_config.logLevel !== 'warn') {
            _log('info', arguments);
        }
    };

    this._debug = function() {
        if (_config.logLevel === 'debug') {
            _log('debug', arguments);
        }
    };

    function _splitURL(url) {
        // [1] = protocol://,
        // [2] = host:port,
        // [3] = host,
        // [4] = IPv6_host,
        // [5] = IPv4_host,
        // [6] = :port,
        // [7] = port,
        // [8] = uri,
        // [9] = rest (query / fragment)
        return /(^https?:\/\/)?(((\[[^\]]+\])|([^:\/\?#]+))(:(\d+))?)?([^\?#]*)(.*)?/.exec(url);
    }

    /**
     * Returns whether the given hostAndPort is cross domain.
     * The default implementation checks against window.location.host
     * but this function can be overridden to make it work in non-browser
     * environments.
     *
     * @param hostAndPort the host and port in format host:port
     * @return whether the given hostAndPort is cross domain
     */
    this._isCrossDomain = function(hostAndPort) {
        return hostAndPort && hostAndPort !== window.location.host;
    };

    function _configure(configuration) {
        _cometd._debug('Configuring cometd object with', configuration);
        // Support old style param, where only the Bayeux server URL was passed
        if (_isString(configuration)) {
            configuration = { url: configuration };
        }
        if (!configuration) {
            configuration = {};
        }

        _config = _cometd._mixin(false, _config, configuration);

        var url = _cometd.getURL();
        if (!url) {
            throw 'Missing required configuration parameter \'url\' specifying the Bayeux server URL';
        }

        // Check if we're cross domain.
        var urlParts = _splitURL(url);
        var hostAndPort = urlParts[2];
        var uri = urlParts[8];
        var afterURI = urlParts[9];
        _crossDomain = _cometd._isCrossDomain(hostAndPort);

        // Check if appending extra path is supported
        if (_config.appendMessageTypeToURL) {
            if (afterURI !== undefined && afterURI.length > 0) {
                _cometd._info('Appending message type to URI ' + uri + afterURI + ' is not supported, disabling \'appendMessageTypeToURL\' configuration');
                _config.appendMessageTypeToURL = false;
            } else {
                var uriSegments = uri.split('/');
                var lastSegmentIndex = uriSegments.length - 1;
                if (uri.match(/\/$/)) {
                    lastSegmentIndex -= 1;
                }
                if (uriSegments[lastSegmentIndex].indexOf('.') >= 0) {
                    // Very likely the CometD servlet's URL pattern is mapped to an extension, such as *.cometd
                    // It will be difficult to add the extra path in this case
                    _cometd._info('Appending message type to URI ' + uri + ' is not supported, disabling \'appendMessageTypeToURL\' configuration');
                    _config.appendMessageTypeToURL = false;
                }
            }
        }
    }

    function _removeListener(subscription) {
        if (subscription) {
            var subscriptions = _listeners[subscription.channel];
            if (subscriptions && subscriptions[subscription.id]) {
                delete subscriptions[subscription.id];
                _cometd._debug('Removed', subscription.listener ? 'listener' : 'subscription', subscription);
            }
        }
    }

    function _removeSubscription(subscription) {
        if (subscription && !subscription.listener) {
            _removeListener(subscription);
        }
    }

    function _clearSubscriptions() {
        for (var channel in _listeners) {
            if (_listeners.hasOwnProperty(channel)) {
                var subscriptions = _listeners[channel];
                if (subscriptions) {
                    for (var i = 0; i < subscriptions.length; ++i) {
                        _removeSubscription(subscriptions[i]);
                    }
                }
            }
        }
    }

    function _setStatus(newStatus) {
        if (_status !== newStatus) {
            _cometd._debug('Status', _status, '->', newStatus);
            _status = newStatus;
        }
    }

    function _isDisconnected() {
        return _status === 'disconnecting' || _status === 'disconnected';
    }

    function _nextMessageId() {
        var result = ++_messageId;
        return '' + result;
    }

    function _applyExtension(scope, callback, name, message, outgoing) {
        try {
            return callback.call(scope, message);
        } catch (x) {
            var handler = _cometd.onExtensionException;
            if (_isFunction(handler)) {
                _cometd._debug('Invoking extension exception handler', name, x);
                try {
                    handler.call(_cometd, x, name, outgoing, message);
                } catch (xx) {
                    _cometd._info('Exception during execution of extension exception handler', name, xx);
                }
            } else {
                _cometd._info('Exception during execution of extension', name, x);
            }
            return message;
        }
    }

    function _applyIncomingExtensions(message) {
        for (var i = 0; i < _extensions.length; ++i) {
            if (message === undefined || message === null) {
                break;
            }

            var index = _config.reverseIncomingExtensions ? _extensions.length - 1 - i : i;
            var extension = _extensions[index];
            var callback = extension.extension.incoming;
            if (_isFunction(callback)) {
                var result = _applyExtension(extension.extension, callback, extension.name, message, false);
                message = result === undefined ? message : result;
            }
        }
        return message;
    }

    function _applyOutgoingExtensions(message) {
        for (var i = 0; i < _extensions.length; ++i) {
            if (message === undefined || message === null) {
                break;
            }

            var extension = _extensions[i];
            var callback = extension.extension.outgoing;
            if (_isFunction(callback)) {
                var result = _applyExtension(extension.extension, callback, extension.name, message, true);
                message = result === undefined ? message : result;
            }
        }
        return message;
    }

    function _notify(channel, message) {
        var subscriptions = _listeners[channel];
        if (subscriptions && subscriptions.length > 0) {
            for (var i = 0; i < subscriptions.length; ++i) {
                var subscription = subscriptions[i];
                // Subscriptions may come and go, so the array may have 'holes'
                if (subscription) {
                    try {
                        subscription.callback.call(subscription.scope, message);
                    } catch (x) {
                        var handler = _cometd.onListenerException;
                        if (_isFunction(handler)) {
                            _cometd._debug('Invoking listener exception handler', subscription, x);
                            try {
                                handler.call(_cometd, x, subscription, subscription.listener, message);
                            } catch (xx) {
                                _cometd._info('Exception during execution of listener exception handler', subscription, xx);
                            }
                        } else {
                            _cometd._info('Exception during execution of listener', subscription, message, x);
                        }
                    }
                }
            }
        }
    }

    function _notifyListeners(channel, message) {
        // Notify direct listeners
        _notify(channel, message);

        // Notify the globbing listeners
        var channelParts = channel.split('/');
        var last = channelParts.length - 1;
        for (var i = last; i > 0; --i) {
            var channelPart = channelParts.slice(0, i).join('/') + '/*';
            // We don't want to notify /foo/* if the channel is /foo/bar/baz,
            // so we stop at the first non recursive globbing
            if (i === last) {
                _notify(channelPart, message);
            }
            // Add the recursive globber and notify
            channelPart += '*';
            _notify(channelPart, message);
        }
    }

    function _cancelDelayedSend() {
        if (_scheduledSend !== null) {
            org.cometd.Utils.clearTimeout(_scheduledSend);
        }
        _scheduledSend = null;
    }

    function _delayedSend(operation, delay) {
        _cancelDelayedSend();
        var time = _advice.interval + delay;
        _cometd._debug('Function scheduled in', time, 'ms, interval =', _advice.interval, 'backoff =', _backoff, operation);
        _scheduledSend = org.cometd.Utils.setTimeout(_cometd, operation, time);
    }

    // Needed to break cyclic dependencies between function definitions
    var _handleMessages;
    var _handleFailure;

    /**
     * Delivers the messages to the CometD server
     * @param sync whether the send is synchronous
     * @param messages the array of messages to send
     * @param metaConnect true if this send is on /meta/connect
     * @param extraPath an extra path to append to the Bayeux server URL
     */
    function _send(sync, messages, metaConnect, extraPath) {
        // We must be sure that the messages have a clientId.
        // This is not guaranteed since the handshake may take time to return
        // (and hence the clientId is not known yet) and the application
        // may create other messages.
        for (var i = 0; i < messages.length; ++i) {
            var message = messages[i];
            var messageId = message.id;

            if (_clientId) {
                message.clientId = _clientId;
            }

            message = _applyOutgoingExtensions(message);
            if (message !== undefined && message !== null) {
                // Extensions may have modified the message id, but we need to own it.
                message.id = messageId;
                messages[i] = message;
            } else {
                delete _callbacks[messageId];
                messages.splice(i--, 1);
            }
        }

        if (messages.length === 0) {
            return;
        }

        var url = _cometd.getURL();
        if (_config.appendMessageTypeToURL) {
            // If url does not end with '/', then append it
            if (!url.match(/\/$/)) {
                url = url + '/';
            }
            if (extraPath) {
                url = url + extraPath;
            }
        }

        var envelope = {
            url: url,
            sync: sync,
            messages: messages,
            onSuccess: function(rcvdMessages) {
                try {
                    _handleMessages.call(_cometd, rcvdMessages);
                } catch (x) {
                    _cometd._info('Exception during handling of messages', x);
                }
            },
            onFailure: function(conduit, messages, failure) {
                try {
                    var transport = _cometd.getTransport();
                    failure.connectionType = transport ? transport.getType() : "unknown";
                    _handleFailure.call(_cometd, conduit, messages, failure);
                } catch (x) {
                    _cometd._info('Exception during handling of failure', x);
                }
            }
        };
        _cometd._debug('Send', envelope);
        _transport.send(envelope, metaConnect);
    }

    function _queueSend(message) {
        if (_batch > 0 || _internalBatch === true) {
            _messageQueue.push(message);
        } else {
            _send(false, [message], false);
        }
    }

    /**
     * Sends a complete bayeux message.
     * This method is exposed as a public so that extensions may use it
     * to send bayeux message directly, for example in case of re-sending
     * messages that have already been sent but that for some reason must
     * be resent.
     */
    this.send = _queueSend;

    function _resetBackoff() {
        _backoff = 0;
    }

    function _increaseBackoff() {
        if (_backoff < _config.maxBackoff) {
            _backoff += _config.backoffIncrement;
        }
        return _backoff;
    }

    /**
     * Starts a the batch of messages to be sent in a single request.
     * @see #_endBatch(sendMessages)
     */
    function _startBatch() {
        ++_batch;
        _cometd._debug('Starting batch, depth', _batch);
    }

    function _flushBatch() {
        var messages = _messageQueue;
        _messageQueue = [];
        if (messages.length > 0) {
            _send(false, messages, false);
        }
    }

    /**
     * Ends the batch of messages to be sent in a single request,
     * optionally sending messages present in the message queue depending
     * on the given argument.
     * @see #_startBatch()
     */
    function _endBatch() {
        --_batch;
        _cometd._debug('Ending batch, depth', _batch);
        if (_batch < 0) {
            throw 'Calls to startBatch() and endBatch() are not paired';
        }

        if (_batch === 0 && !_isDisconnected() && !_internalBatch) {
            _flushBatch();
        }
    }

    /**
     * Sends the connect message
     */
    function _connect() {
        if (!_isDisconnected()) {
            var bayeuxMessage = {
                id: _nextMessageId(),
                channel: '/meta/connect',
                connectionType: _transport.getType()
            };

            // In case of reload or temporary loss of connection
            // we want the next successful connect to return immediately
            // instead of being held by the server, so that connect listeners
            // can be notified that the connection has been re-established
            if (!_connected) {
                bayeuxMessage.advice = { timeout: 0 };
            }

            _setStatus('connecting');
            _cometd._debug('Connect sent', bayeuxMessage);
            _send(false, [bayeuxMessage], true, 'connect');
            _setStatus('connected');
        }
    }

    function _delayedConnect(delay) {
        _setStatus('connecting');
        _delayedSend(function() {
            _connect();
        }, delay);
    }

    function _updateAdvice(newAdvice) {
        if (newAdvice) {
            _advice = _cometd._mixin(false, {}, _config.advice, newAdvice);
            _cometd._debug('New advice', _advice);
        }
    }

    function _disconnect(abort) {
        _cancelDelayedSend();
        if (abort && _transport) {
            _transport.abort();
        }
        _clientId = null;
        _setStatus('disconnected');
        _batch = 0;
        _resetBackoff();
        _transport = null;

        // Fail any existing queued message
        if (_messageQueue.length > 0) {
            var messages = _messageQueue;
            _messageQueue = [];
            _handleFailure.call(_cometd, undefined, messages, {
                reason: 'Disconnected'
            });
        }
    }

    function _notifyTransportException(oldTransport, newTransport, failure) {
        var handler = _cometd.onTransportException;
        if (_isFunction(handler)) {
            _cometd._debug('Invoking transport exception handler', oldTransport, newTransport, failure);
            try {
                handler.call(_cometd, failure, oldTransport, newTransport);
            } catch (x) {
                _cometd._info('Exception during execution of transport exception handler', x);
            }
        }
    }

    /**
     * Sends the initial handshake message
     */
    function _handshake(handshakeProps, handshakeCallback) {
        if (_isFunction(handshakeProps)) {
            handshakeCallback = handshakeProps;
            handshakeProps = undefined;
        }

        _clientId = null;

        _clearSubscriptions();

        // Reset the transports if we're not retrying the handshake
        if (_isDisconnected()) {
            _transports.reset(true);
            _updateAdvice(_config.advice);
        } else {
            // We are retrying the handshake, either because another handshake failed
            // and we're backing off, or because the server timed us out and asks us to
            // re-handshake: in both cases, make sure that if the handshake succeeds
            // the next action is a connect.
            _updateAdvice(_cometd._mixin(false, _advice, {reconnect: 'retry'}));
        }

        _batch = 0;

        // Mark the start of an internal batch.
        // This is needed because handshake and connect are async.
        // It may happen that the application calls init() then subscribe()
        // and the subscribe message is sent before the connect message, if
        // the subscribe message is not held until the connect message is sent.
        // So here we start a batch to hold temporarily any message until
        // the connection is fully established.
        _internalBatch = true;

        // Save the properties provided by the user, so that
        // we can reuse them during automatic re-handshake
        _handshakeProps = handshakeProps;
        _handshakeCallback = handshakeCallback;

        var version = '1.0';

        // Figure out the transports to send to the server
        var url = _cometd.getURL();
        var transportTypes = _transports.findTransportTypes(version, _crossDomain, url);

        var bayeuxMessage = {
            id: _nextMessageId(),
            version: version,
            minimumVersion: version,
            channel: '/meta/handshake',
            supportedConnectionTypes: transportTypes,
            advice: {
                timeout: _advice.timeout,
                interval: _advice.interval
            }
        };
        // Do not allow the user to override important fields.
        var message = _cometd._mixin(false, {}, _handshakeProps, bayeuxMessage);

        // Save the callback.
        _cometd._putCallback(message.id, handshakeCallback);

        // Pick up the first available transport as initial transport
        // since we don't know if the server supports it
        if (!_transport) {
            _transport = _transports.negotiateTransport(transportTypes, version, _crossDomain, url);
            if (!_transport) {
                var failure = 'Could not find initial transport among: ' + _transports.getTransportTypes();
                _cometd._warn(failure);
                throw failure;
            }
        }

        _cometd._debug('Initial transport is', _transport.getType());

        // We started a batch to hold the application messages,
        // so here we must bypass it and send immediately.
        _setStatus('handshaking');
        _cometd._debug('Handshake sent', message);
        _send(false, [message], false, 'handshake');
    }

    function _delayedHandshake(delay) {
        _setStatus('handshaking');

        // We will call _handshake() which will reset _clientId, but we want to avoid
        // that between the end of this method and the call to _handshake() someone may
        // call publish() (or other methods that call _queueSend()).
        _internalBatch = true;

        _delayedSend(function() {
            _handshake(_handshakeProps, _handshakeCallback);
        }, delay);
    }

    function _notifyCallback(callback, message) {
        try {
            callback.call(_cometd, message);
        } catch (x) {
            var handler = _cometd.onCallbackException;
            if (_isFunction(handler)) {
                _cometd._debug('Invoking callback exception handler', x);
                try {
                    handler.call(_cometd, x, message);
                } catch (xx) {
                    _cometd._info('Exception during execution of callback exception handler', xx);
                }
            } else {
                _cometd._info('Exception during execution of message callback', x);
            }
        }
    }

    this._getCallback = function(messageId) {
        return _callbacks[messageId];
    };

    this._putCallback = function(messageId, callback) {
        var result = this._getCallback(messageId);
        if (_isFunction(callback)) {
            _callbacks[messageId] = callback;
        }
        return result;
    };

    function _handleCallback(message) {
        var callback = _cometd._getCallback([message.id]);
        if (_isFunction(callback)) {
            delete _callbacks[message.id];
            _notifyCallback(callback, message);
        }
    }

    function _handleRemoteCall(message) {
        var context = _remoteCalls[message.id];
        delete _remoteCalls[message.id];
        _cometd._debug('Handling remote call response for', message, 'with context', context);
        if (context) {
            // Clear the timeout, if present.
            var timeout = context.timeout;
            if (timeout) {
                org.cometd.Utils.clearTimeout(timeout);
            }

            var callback = context.callback;
            if (_isFunction(callback)) {
                _notifyCallback(callback, message);
                return true;
            }
        }
        return false;
    }

    this.onTransportFailure = function(message, failureInfo, actionFn) {
        this._debug('Transport failure', failureInfo);

        var actionInfo = {
            delay: this.getBackoffPeriod(),
            transport: this.getTransport()
        };

        var transports = this.getTransportRegistry();
        var url = this.getURL();
        var crossDomain = this._isCrossDomain(_splitURL(url)[2]);
        var version = '1.0';
        var transportTypes = transports.findTransportTypes(version, crossDomain, url);
        var action = failureInfo.action;
        if (action === 'disconnect') {
            if (message.channel === '/meta/handshake') {
                if (failureInfo.cause === 'negotiation') {
                    var failure = 'Could not negotiate transport, client=[' + transportTypes + '], server=[' + message.supportedConnectionTypes + ']';
                    this._warn(failure);
                    _notifyTransportException(_transport.getType(), null, {
                        reason: failure,
                        connectionType: _transport.getType(),
                        transport: _transport
                    });
                    action = 'disconnect';
                }
            }
        } else {
            // Different logic depending on whether we are handshaking or connecting.
            if (message.channel === '/meta/handshake') {
                if (!failureInfo.transport.valid) {
                    // The transport is invalid, try to negotiate again.
                    var newTransport = transports.negotiateTransport(transportTypes, version, crossDomain, url);
                    if (!newTransport) {
                        this._warn('Could not negotiate transport, client=[' + transportTypes + ']');
                        _notifyTransportException(_transport.getType(), null, message.failure);
                        action = 'disconnect';
                    } else {
                        this._debug('Transport', _transport.getType(), '->', newTransport.getType());
                        _notifyTransportException(_transport.getType(), newTransport.getType(), message.failure);
                        action = 'handshake';
                        actionInfo.transport = newTransport;
                    }
                }
            } else {
                var now = new Date().getTime();

                if (_unconnectTime === 0) {
                    _unconnectTime = now;
                }

                // Check whether we may switch to handshaking.
                var maxInterval = _advice.maxInterval;
                if (maxInterval > 0) {
                    var expiration = _advice.timeout + _advice.interval + maxInterval;
                    var unconnected = now - _unconnectTime;
                    if (unconnected + _backoff > expiration) {
                        action = 'handshake';
                    }
                }

                if (action === 'handshake') {
                    transports.reset(false);
                    this.resetBackoffPeriod();
                }
            }
        }

        if (action !== 'disconnect') {
            this.increaseBackoffPeriod();
        }

        actionInfo.action = action;

        actionFn.call(_cometd, actionInfo);
    };

    function _onTransportAction(actionInfo) {
        _cometd._debug('Transport action', actionInfo);

        if (actionInfo.transport) {
            _transport = actionInfo.transport;
        }

        if (actionInfo.url) {
            _transport.setURL(actionInfo.url);
        }

        var action = actionInfo.action;
        var delay = actionInfo.delay || 0;
        switch (action) {
            case 'handshake':
                _delayedHandshake(delay);
                break;
            case 'connect':
                _delayedConnect(delay);
                break;
            case 'disconnect':
                _disconnect(true);
                break;
            default:
                throw 'Unknown action ' + action;
        }
    }

    function _failHandshake(message, failureInfo) {
        _handleCallback(message);
        _notifyListeners('/meta/handshake', message);
        _notifyListeners('/meta/unsuccessful', message);

        // The listeners may have disconnected.
        if (_isDisconnected()) {
            failureInfo.action = 'disconnect';
        }

        _cometd.onTransportFailure.call(_cometd, message, failureInfo, _onTransportAction);
    }

    function _handshakeResponse(message) {
        var url = _cometd.getURL();
        if (message.successful) {
            var crossDomain = _cometd._isCrossDomain(_splitURL(url)[2]);
            var newTransport = _transports.negotiateTransport(message.supportedConnectionTypes, message.version, crossDomain, url);
            if (newTransport === null) {
                message.successful = false;
                _failHandshake(message, {
                    cause: 'negotiation',
                    action: 'disconnect',
                    transport: {
                        type: _transport.getType(),
                        url: url,
                        valid: true
                    }
                });
                return;
            } else if (_transport !== newTransport) {
                _cometd._debug('Transport', _transport.getType(), '->', newTransport.getType());
                _transport = newTransport;
            }

            _clientId = message.clientId;

            // End the internal batch and allow held messages from the application
            // to go to the server (see _handshake() where we start the internal batch).
            _internalBatch = false;
            _flushBatch();

            // Here the new transport is in place, as well as the clientId, so
            // the listeners can perform a publish() if they want.
            // Notify the listeners before the connect below.
            message.reestablish = _reestablish;
            _reestablish = true;

            _handleCallback(message);
            _notifyListeners('/meta/handshake', message);

            var action = _isDisconnected() ? 'none' : _advice.reconnect;
            switch (action) {
                case 'retry':
                    _resetBackoff();
                    _delayedConnect(_backoff);
                    break;
                case 'none':
                    _disconnect(true);
                    break;
                default:
                    throw 'Unrecognized advice action ' + action;
            }
        } else {
            var failAction = 'handshake';
            if (_advice.reconnect === 'none') {
                failAction = 'disconnect';
            }

            _failHandshake(message, {
                cause: 'unsuccessful',
                action: failAction,
                transport: {
                    type: _transport.getType(),
                    url: url,
                    valid: true
                }
            });
        }
    }

    function _handshakeFailure(message) {
        var action = 'handshake';
        if (_advice.reconnect === 'none') {
            action = 'disconnect';
        }

        _failHandshake(message, {
            cause: 'failure',
            action: action,
            transport: {
                type: _transport.getType(),
                url: _cometd.getURL(),
                valid: false
            }
        });
    }

    function _failConnect(message, failureInfo) {
        // Notify the listeners after the status change but before the next action.
        _notifyListeners('/meta/connect', message);
        _notifyListeners('/meta/unsuccessful', message);

        var action = 'connect';
        switch (_advice.reconnect) {
            case 'handshake':
                action = 'handshake';
                break;
            case 'none':
                action = 'disconnect';
                break;
        }

        // The listeners may have disconnected.
        if (_isDisconnected()) {
            action = 'disconnect';
        }

        failureInfo.action = action;

        _cometd.onTransportFailure.call(_cometd, message, failureInfo, _onTransportAction);
    }

    function _connectResponse(message) {
        _connected = message.successful;

        if (_connected) {
            _notifyListeners('/meta/connect', message);

            // Normally, the advice will say "reconnect: 'retry', interval: 0"
            // and the server will hold the request, so when a response returns
            // we immediately call the server again (long polling).
            // Listeners can call disconnect(), so check the state after they run.
            var action = _isDisconnected() ? 'none' : _advice.reconnect;
            switch (action) {
                case 'retry':
                    _resetBackoff();
                    _delayedConnect(_backoff);
                    break;
                case 'none':
                    _disconnect(false);
                    break;
                default:
                    throw 'Unrecognized advice action ' + action;
            }
        } else {
            _failConnect(message, {
                cause: 'unsuccessful',
                transport: {
                    type: _transport.getType(),
                    url: _cometd.getURL(),
                    valid: true
                }
            });
        }
    }

    function _connectFailure(message) {
        _connected = false;

        _failConnect(message, {
            cause: 'failure',
            transport: {
                type: _transport.getType(),
                url: _cometd.getURL(),
                valid: false
            }
        });
    }

    function _failDisconnect(message) {
        _disconnect(true);
        _handleCallback(message);
        _notifyListeners('/meta/disconnect', message);
        _notifyListeners('/meta/unsuccessful', message);
    }

    function _disconnectResponse(message) {
        if (message.successful) {
            // Wait for the /meta/connect to arrive.
            _disconnect(false);
            _handleCallback(message);
            _notifyListeners('/meta/disconnect', message);
        } else {
            _failDisconnect(message);
        }
    }

    function _disconnectFailure(message) {
        _failDisconnect(message);
    }

    function _failSubscribe(message) {
        var subscriptions = _listeners[message.subscription];
        if (subscriptions) {
            for (var i = subscriptions.length - 1; i >= 0; --i) {
                var subscription = subscriptions[i];
                if (subscription && !subscription.listener) {
                    delete subscriptions[i];
                    _cometd._debug('Removed failed subscription', subscription);
                    break;
                }
            }
        }
        _handleCallback(message);
        _notifyListeners('/meta/subscribe', message);
        _notifyListeners('/meta/unsuccessful', message);
    }

    function _subscribeResponse(message) {
        if (message.successful) {
            _handleCallback(message);
            _notifyListeners('/meta/subscribe', message);
        } else {
            _failSubscribe(message);
        }
    }

    function _subscribeFailure(message) {
        _failSubscribe(message);
    }

    function _failUnsubscribe(message) {
        _handleCallback(message);
        _notifyListeners('/meta/unsubscribe', message);
        _notifyListeners('/meta/unsuccessful', message);
    }

    function _unsubscribeResponse(message) {
        if (message.successful) {
            _handleCallback(message);
            _notifyListeners('/meta/unsubscribe', message);
        } else {
            _failUnsubscribe(message);
        }
    }

    function _unsubscribeFailure(message) {
        _failUnsubscribe(message);
    }

    function _failMessage(message) {
        if (!_handleRemoteCall(message)) {
            _handleCallback(message);
            _notifyListeners('/meta/publish', message);
            _notifyListeners('/meta/unsuccessful', message);
        }
    }

    function _messageResponse(message) {
        if (message.data !== undefined) {
            if (!_handleRemoteCall(message)) {
                _notifyListeners(message.channel, message);
            }
        } else {
            if (message.successful === undefined) {
                _cometd._warn('Unknown Bayeux Message', message);
            } else {
                if (message.successful) {
                    _handleCallback(message);
                    _notifyListeners('/meta/publish', message);
                } else {
                    _failMessage(message);
                }
            }
        }
    }

    function _messageFailure(failure) {
        _failMessage(failure);
    }

    function _receive(message) {
        _unconnectTime = 0;

        message = _applyIncomingExtensions(message);
        if (message === undefined || message === null) {
            return;
        }

        _updateAdvice(message.advice);

        var channel = message.channel;
        switch (channel) {
            case '/meta/handshake':
                _handshakeResponse(message);
                break;
            case '/meta/connect':
                _connectResponse(message);
                break;
            case '/meta/disconnect':
                _disconnectResponse(message);
                break;
            case '/meta/subscribe':
                _subscribeResponse(message);
                break;
            case '/meta/unsubscribe':
                _unsubscribeResponse(message);
                break;
            default:
                _messageResponse(message);
                break;
        }
    }

    /**
     * Receives a message.
     * This method is exposed as a public so that extensions may inject
     * messages simulating that they had been received.
     */
    this.receive = _receive;

    _handleMessages = function(rcvdMessages) {
        _cometd._debug('Received', rcvdMessages);

        for (var i = 0; i < rcvdMessages.length; ++i) {
            var message = rcvdMessages[i];
            _receive(message);
        }
    };

    _handleFailure = function(conduit, messages, failure) {
        _cometd._debug('handleFailure', conduit, messages, failure);

        failure.transport = conduit;
        for (var i = 0; i < messages.length; ++i) {
            var message = messages[i];
            var failureMessage = {
                id: message.id,
                successful: false,
                channel: message.channel,
                failure: failure
            };
            failure.message = message;
            switch (message.channel) {
                case '/meta/handshake':
                    _handshakeFailure(failureMessage);
                    break;
                case '/meta/connect':
                    _connectFailure(failureMessage);
                    break;
                case '/meta/disconnect':
                    _disconnectFailure(failureMessage);
                    break;
                case '/meta/subscribe':
                    failureMessage.subscription = message.subscription;
                    _subscribeFailure(failureMessage);
                    break;
                case '/meta/unsubscribe':
                    failureMessage.subscription = message.subscription;
                    _unsubscribeFailure(failureMessage);
                    break;
                default:
                    _messageFailure(failureMessage);
                    break;
            }
        }
    };

    function _hasSubscriptions(channel) {
        var subscriptions = _listeners[channel];
        if (subscriptions) {
            for (var i = 0; i < subscriptions.length; ++i) {
                if (subscriptions[i]) {
                    return true;
                }
            }
        }
        return false;
    }

    function _resolveScopedCallback(scope, callback) {
        var delegate = {
            scope: scope,
            method: callback
        };
        if (_isFunction(scope)) {
            delegate.scope = undefined;
            delegate.method = scope;
        } else {
            if (_isString(callback)) {
                if (!scope) {
                    throw 'Invalid scope ' + scope;
                }
                delegate.method = scope[callback];
                if (!_isFunction(delegate.method)) {
                    throw 'Invalid callback ' + callback + ' for scope ' + scope;
                }
            } else if (!_isFunction(callback)) {
                throw 'Invalid callback ' + callback;
            }
        }
        return delegate;
    }

    function _addListener(channel, scope, callback, isListener) {
        // The data structure is a map<channel, subscription[]>, where each subscription
        // holds the callback to be called and its scope.

        var delegate = _resolveScopedCallback(scope, callback);
        _cometd._debug('Adding', isListener ? 'listener' : 'subscription', 'on', channel, 'with scope', delegate.scope, 'and callback', delegate.method);

        var subscription = {
            channel: channel,
            scope: delegate.scope,
            callback: delegate.method,
            listener: isListener
        };

        var subscriptions = _listeners[channel];
        if (!subscriptions) {
            subscriptions = [];
            _listeners[channel] = subscriptions;
        }

        // Pushing onto an array appends at the end and returns the id associated with the element increased by 1.
        // Note that if:
        // a.push('a'); var hb=a.push('b'); delete a[hb-1]; var hc=a.push('c');
        // then:
        // hc==3, a.join()=='a',,'c', a.length==3
        subscription.id = subscriptions.push(subscription) - 1;

        _cometd._debug('Added', isListener ? 'listener' : 'subscription', subscription);

        // For backward compatibility: we used to return [channel, subscription.id]
        subscription[0] = channel;
        subscription[1] = subscription.id;

        return subscription;
    }

    //
    // PUBLIC API
    //

    /**
     * Registers the given transport under the given transport type.
     * The optional index parameter specifies the "priority" at which the
     * transport is registered (where 0 is the max priority).
     * If a transport with the same type is already registered, this function
     * does nothing and returns false.
     * @param type the transport type
     * @param transport the transport object
     * @param index the index at which this transport is to be registered
     * @return true if the transport has been registered, false otherwise
     * @see #unregisterTransport(type)
     */
    this.registerTransport = function(type, transport, index) {
        var result = _transports.add(type, transport, index);
        if (result) {
            this._debug('Registered transport', type);

            if (_isFunction(transport.registered)) {
                transport.registered(type, this);
            }
        }
        return result;
    };

    /**
     * Unregisters the transport with the given transport type.
     * @param type the transport type to unregister
     * @return the transport that has been unregistered,
     * or null if no transport was previously registered under the given transport type
     */
    this.unregisterTransport = function(type) {
        var transport = _transports.remove(type);
        if (transport !== null) {
            this._debug('Unregistered transport', type);

            if (_isFunction(transport.unregistered)) {
                transport.unregistered();
            }
        }
        return transport;
    };

    this.unregisterTransports = function() {
        _transports.clear();
    };

    /**
     * @return an array of all registered transport types
     */
    this.getTransportTypes = function() {
        return _transports.getTransportTypes();
    };

    this.findTransport = function(name) {
        return _transports.find(name);
    };

    /**
     * @returns the TransportRegistry object
     */
    this.getTransportRegistry = function() {
        return _transports;
    };

    /**
     * Configures the initial Bayeux communication with the Bayeux server.
     * Configuration is passed via an object that must contain a mandatory field <code>url</code>
     * of type string containing the URL of the Bayeux server.
     * @param configuration the configuration object
     */
    this.configure = function(configuration) {
        _configure.call(this, configuration);
    };

    /**
     * Configures and establishes the Bayeux communication with the Bayeux server
     * via a handshake and a subsequent connect.
     * @param configuration the configuration object
     * @param handshakeProps an object to be merged with the handshake message
     * @see #configure(configuration)
     * @see #handshake(handshakeProps)
     */
    this.init = function(configuration, handshakeProps) {
        this.configure(configuration);
        this.handshake(handshakeProps);
    };

    /**
     * Establishes the Bayeux communication with the Bayeux server
     * via a handshake and a subsequent connect.
     * @param handshakeProps an object to be merged with the handshake message
     * @param handshakeCallback a function to be invoked when the handshake is acknowledged
     */
    this.handshake = function(handshakeProps, handshakeCallback) {
        _setStatus('disconnected');
        _reestablish = false;
        _handshake(handshakeProps, handshakeCallback);
    };

    /**
     * Disconnects from the Bayeux server.
     * It is possible to suggest to attempt a synchronous disconnect, but this feature
     * may only be available in certain transports (for example, long-polling may support
     * it, callback-polling certainly does not).
     * @param sync whether attempt to perform a synchronous disconnect
     * @param disconnectProps an object to be merged with the disconnect message
     * @param disconnectCallback a function to be invoked when the disconnect is acknowledged
     */
    this.disconnect = function(sync, disconnectProps, disconnectCallback) {
        if (_isDisconnected()) {
            return;
        }

        if (typeof sync !== 'boolean') {
            disconnectCallback = disconnectProps;
            disconnectProps = sync;
            sync = false;
        }
        if (_isFunction(disconnectProps)) {
            disconnectCallback = disconnectProps;
            disconnectProps = undefined;
        }

        var bayeuxMessage = {
            id: _nextMessageId(),
            channel: '/meta/disconnect'
        };
        // Do not allow the user to override important fields.
        var message = this._mixin(false, {}, disconnectProps, bayeuxMessage);

        // Save the callback.
        _cometd._putCallback(message.id, disconnectCallback);

        _setStatus('disconnecting');
        _send(sync === true, [message], false, 'disconnect');
    };

    /**
     * Marks the start of a batch of application messages to be sent to the server
     * in a single request, obtaining a single response containing (possibly) many
     * application reply messages.
     * Messages are held in a queue and not sent until {@link #endBatch()} is called.
     * If startBatch() is called multiple times, then an equal number of endBatch()
     * calls must be made to close and send the batch of messages.
     * @see #endBatch()
     */
    this.startBatch = function() {
        _startBatch();
    };

    /**
     * Marks the end of a batch of application messages to be sent to the server
     * in a single request.
     * @see #startBatch()
     */
    this.endBatch = function() {
        _endBatch();
    };

    /**
     * Executes the given callback in the given scope, surrounded by a {@link #startBatch()}
     * and {@link #endBatch()} calls.
     * @param scope the scope of the callback, may be omitted
     * @param callback the callback to be executed within {@link #startBatch()} and {@link #endBatch()} calls
     */
    this.batch = function(scope, callback) {
        var delegate = _resolveScopedCallback(scope, callback);
        this.startBatch();
        try {
            delegate.method.call(delegate.scope);
            this.endBatch();
        } catch (x) {
            this._info('Exception during execution of batch', x);
            this.endBatch();
            throw x;
        }
    };

    /**
     * Adds a listener for bayeux messages, performing the given callback in the given scope
     * when a message for the given channel arrives.
     * @param channel the channel the listener is interested to
     * @param scope the scope of the callback, may be omitted
     * @param callback the callback to call when a message is sent to the channel
     * @returns the subscription handle to be passed to {@link #removeListener(object)}
     * @see #removeListener(subscription)
     */
    this.addListener = function(channel, scope, callback) {
        if (arguments.length < 2) {
            throw 'Illegal arguments number: required 2, got ' + arguments.length;
        }
        if (!_isString(channel)) {
            throw 'Illegal argument type: channel must be a string';
        }

        return _addListener(channel, scope, callback, true);
    };

    /**
     * Removes the subscription obtained with a call to {@link #addListener(string, object, function)}.
     * @param subscription the subscription to unsubscribe.
     * @see #addListener(channel, scope, callback)
     */
    this.removeListener = function(subscription) {
        // Beware of subscription.id == 0, which is falsy => cannot use !subscription.id
        if (!subscription || !subscription.channel || !("id" in subscription)) {
            throw 'Invalid argument: expected subscription, not ' + subscription;
        }

        _removeListener(subscription);
    };

    /**
     * Removes all listeners registered with {@link #addListener(channel, scope, callback)} or
     * {@link #subscribe(channel, scope, callback)}.
     */
    this.clearListeners = function() {
        _listeners = {};
    };

    /**
     * Subscribes to the given channel, performing the given callback in the given scope
     * when a message for the channel arrives.
     * @param channel the channel to subscribe to
     * @param scope the scope of the callback, may be omitted
     * @param callback the callback to call when a message is sent to the channel
     * @param subscribeProps an object to be merged with the subscribe message
     * @param subscribeCallback a function to be invoked when the subscription is acknowledged
     * @return the subscription handle to be passed to {@link #unsubscribe(object)}
     */
    this.subscribe = function(channel, scope, callback, subscribeProps, subscribeCallback) {
        if (arguments.length < 2) {
            throw 'Illegal arguments number: required 2, got ' + arguments.length;
        }
        if (!_isString(channel)) {
            throw 'Illegal argument type: channel must be a string';
        }
        if (_isDisconnected()) {
            throw 'Illegal state: already disconnected';
        }

        // Normalize arguments
        if (_isFunction(scope)) {
            subscribeCallback = subscribeProps;
            subscribeProps = callback;
            callback = scope;
            scope = undefined;
        }
        if (_isFunction(subscribeProps)) {
            subscribeCallback = subscribeProps;
            subscribeProps = undefined;
        }

        // Only send the message to the server if this client has not yet subscribed to the channel
        var send = !_hasSubscriptions(channel);

        var subscription = _addListener(channel, scope, callback, false);

        if (send) {
            // Send the subscription message after the subscription registration to avoid
            // races where the server would send a message to the subscribers, but here
            // on the client the subscription has not been added yet to the data structures
            var bayeuxMessage = {
                id: _nextMessageId(),
                channel: '/meta/subscribe',
                subscription: channel
            };
            // Do not allow the user to override important fields.
            var message = this._mixin(false, {}, subscribeProps, bayeuxMessage);

            // Save the callback.
            _cometd._putCallback(message.id, subscribeCallback);

            _queueSend(message);
        }

        return subscription;
    };

    /**
     * Unsubscribes the subscription obtained with a call to {@link #subscribe(string, object, function)}.
     * @param subscription the subscription to unsubscribe.
     * @param unsubscribeProps an object to be merged with the unsubscribe message
     * @param unsubscribeCallback a function to be invoked when the unsubscription is acknowledged
     */
    this.unsubscribe = function(subscription, unsubscribeProps, unsubscribeCallback) {
        if (arguments.length < 1) {
            throw 'Illegal arguments number: required 1, got ' + arguments.length;
        }
        if (_isDisconnected()) {
            throw 'Illegal state: already disconnected';
        }

        if (_isFunction(unsubscribeProps)) {
            unsubscribeCallback = unsubscribeProps;
            unsubscribeProps = undefined;
        }

        // Remove the local listener before sending the message
        // This ensures that if the server fails, this client does not get notifications
        this.removeListener(subscription);

        var channel = subscription.channel;
        // Only send the message to the server if this client unsubscribes the last subscription
        if (!_hasSubscriptions(channel)) {
            var bayeuxMessage = {
                id: _nextMessageId(),
                channel: '/meta/unsubscribe',
                subscription: channel
            };
            // Do not allow the user to override important fields.
            var message = this._mixin(false, {}, unsubscribeProps, bayeuxMessage);

            // Save the callback.
            _cometd._putCallback(message.id, unsubscribeCallback);

            _queueSend(message);
        }
    };

    this.resubscribe = function(subscription, subscribeProps) {
        _removeSubscription(subscription);
        if (subscription) {
            return this.subscribe(subscription.channel, subscription.scope, subscription.callback, subscribeProps);
        }
        return undefined;
    };

    /**
     * Removes all subscriptions added via {@link #subscribe(channel, scope, callback, subscribeProps)},
     * but does not remove the listeners added via {@link addListener(channel, scope, callback)}.
     */
    this.clearSubscriptions = function() {
        _clearSubscriptions();
    };

    /**
     * Publishes a message on the given channel, containing the given content.
     * @param channel the channel to publish the message to
     * @param content the content of the message
     * @param publishProps an object to be merged with the publish message
     * @param publishCallback a function to be invoked when the publish is acknowledged by the server
     */
    this.publish = function(channel, content, publishProps, publishCallback) {
        if (arguments.length < 1) {
            throw 'Illegal arguments number: required 1, got ' + arguments.length;
        }
        if (!_isString(channel)) {
            throw 'Illegal argument type: channel must be a string';
        }
        if (/^\/meta\//.test(channel)) {
            throw 'Illegal argument: cannot publish to meta channels';
        }
        if (_isDisconnected()) {
            throw 'Illegal state: already disconnected';
        }

        if (_isFunction(content)) {
            publishCallback = content;
            content = publishProps = {};
        } else if (_isFunction(publishProps)) {
            publishCallback = publishProps;
            publishProps = {};
        }

        var bayeuxMessage = {
            id: _nextMessageId(),
            channel: channel,
            data: content
        };
        // Do not allow the user to override important fields.
        var message = this._mixin(false, {}, publishProps, bayeuxMessage);

        // Save the callback.
        _cometd._putCallback(message.id, publishCallback);

        _queueSend(message);
    };

    this.remoteCall = function(target, content, timeout, callback) {
        if (arguments.length < 1) {
            throw 'Illegal arguments number: required 1, got ' + arguments.length;
        }
        if (!_isString(target)) {
            throw 'Illegal argument type: target must be a string';
        }
        if (_isDisconnected()) {
            throw 'Illegal state: already disconnected';
        }

        if (_isFunction(content)) {
            callback = content;
            content = {};
            timeout = _config.maxNetworkDelay;
        } else if (_isFunction(timeout)) {
            callback = timeout;
            timeout = _config.maxNetworkDelay;
        }

        if (typeof timeout !== 'number') {
            throw 'Illegal argument type: timeout must be a number';
        }

        if (!target.match(/^\//)) {
            target = '/' + target;
        }
        var channel = '/service' + target;

        var bayeuxMessage = {
            id: _nextMessageId(),
            channel: channel,
            data: content
        };

        var context = {
            callback: callback
        };
        if (timeout > 0) {
            context.timeout = org.cometd.Utils.setTimeout(_cometd, function() {
                _cometd._debug('Timing out remote call', bayeuxMessage, 'after', timeout, 'ms');
                _failMessage({
                    id: bayeuxMessage.id,
                    error: '406::timeout',
                    successful: false,
                    failure: {
                        message : bayeuxMessage,
                        reason: 'Remote Call Timeout'
                    }
                });
            }, timeout);
            _cometd._debug('Scheduled remote call timeout', bayeuxMessage, 'in', timeout, 'ms');
        }
        _remoteCalls[bayeuxMessage.id] = context;

        _queueSend(bayeuxMessage);
    };

    /**
     * Returns a string representing the status of the bayeux communication with the Bayeux server.
     */
    this.getStatus = function() {
        return _status;
    };

    /**
     * Returns whether this instance has been disconnected.
     */
    this.isDisconnected = _isDisconnected;

    /**
     * Sets the backoff period used to increase the backoff time when retrying an unsuccessful or failed message.
     * Default value is 1 second, which means if there is a persistent failure the retries will happen
     * after 1 second, then after 2 seconds, then after 3 seconds, etc. So for example with 15 seconds of
     * elapsed time, there will be 5 retries (at 1, 3, 6, 10 and 15 seconds elapsed).
     * @param period the backoff period to set
     * @see #getBackoffIncrement()
     */
    this.setBackoffIncrement = function(period) {
        _config.backoffIncrement = period;
    };

    /**
     * Returns the backoff period used to increase the backoff time when retrying an unsuccessful or failed message.
     * @see #setBackoffIncrement(period)
     */
    this.getBackoffIncrement = function() {
        return _config.backoffIncrement;
    };

    /**
     * Returns the backoff period to wait before retrying an unsuccessful or failed message.
     */
    this.getBackoffPeriod = function() {
        return _backoff;
    };

    /**
     * Increases the backoff period up to the maximum value configured.
     * @returns the backoff period after increment
     * @see getBackoffIncrement
     */
    this.increaseBackoffPeriod = function() {
        return _increaseBackoff();
    };

    /**
     * Resets the backoff period to zero.
     */
    this.resetBackoffPeriod = function() {
        _resetBackoff();
    };

    /**
     * Sets the log level for console logging.
     * Valid values are the strings 'error', 'warn', 'info' and 'debug', from
     * less verbose to more verbose.
     * @param level the log level string
     */
    this.setLogLevel = function(level) {
        _config.logLevel = level;
    };

    /**
     * Registers an extension whose callbacks are called for every incoming message
     * (that comes from the server to this client implementation) and for every
     * outgoing message (that originates from this client implementation for the
     * server).
     * The format of the extension object is the following:
     * <pre>
     * {
     *     incoming: function(message) { ... },
     *     outgoing: function(message) { ... }
     * }
     * </pre>
     * Both properties are optional, but if they are present they will be called
     * respectively for each incoming message and for each outgoing message.
     * @param name the name of the extension
     * @param extension the extension to register
     * @return true if the extension was registered, false otherwise
     * @see #unregisterExtension(name)
     */
    this.registerExtension = function(name, extension) {
        if (arguments.length < 2) {
            throw 'Illegal arguments number: required 2, got ' + arguments.length;
        }
        if (!_isString(name)) {
            throw 'Illegal argument type: extension name must be a string';
        }

        var existing = false;
        for (var i = 0; i < _extensions.length; ++i) {
            var existingExtension = _extensions[i];
            if (existingExtension.name === name) {
                existing = true;
                break;
            }
        }
        if (!existing) {
            _extensions.push({
                name: name,
                extension: extension
            });
            this._debug('Registered extension', name);

            // Callback for extensions
            if (_isFunction(extension.registered)) {
                extension.registered(name, this);
            }

            return true;
        } else {
            this._info('Could not register extension with name', name, 'since another extension with the same name already exists');
            return false;
        }
    };

    /**
     * Unregister an extension previously registered with
     * {@link #registerExtension(name, extension)}.
     * @param name the name of the extension to unregister.
     * @return true if the extension was unregistered, false otherwise
     */
    this.unregisterExtension = function(name) {
        if (!_isString(name)) {
            throw 'Illegal argument type: extension name must be a string';
        }

        var unregistered = false;
        for (var i = 0; i < _extensions.length; ++i) {
            var extension = _extensions[i];
            if (extension.name === name) {
                _extensions.splice(i, 1);
                unregistered = true;
                this._debug('Unregistered extension', name);

                // Callback for extensions
                var ext = extension.extension;
                if (_isFunction(ext.unregistered)) {
                    ext.unregistered();
                }

                break;
            }
        }
        return unregistered;
    };

    /**
     * Find the extension registered with the given name.
     * @param name the name of the extension to find
     * @return the extension found or null if no extension with the given name has been registered
     */
    this.getExtension = function(name) {
        for (var i = 0; i < _extensions.length; ++i) {
            var extension = _extensions[i];
            if (extension.name === name) {
                return extension.extension;
            }
        }
        return null;
    };

    /**
     * Returns the name assigned to this CometD object, or the string 'default'
     * if no name has been explicitly passed as parameter to the constructor.
     */
    this.getName = function() {
        return _name;
    };

    /**
     * Returns the clientId assigned by the Bayeux server during handshake.
     */
    this.getClientId = function() {
        return _clientId;
    };

    /**
     * Returns the URL of the Bayeux server.
     */
    this.getURL = function() {
        if (_transport) {
            var url = _transport.getURL();
            if (url) {
                return url;
            }
            url = _config.urls[_transport.getType()];
            if (url) {
                return url;
            }
        }
        return _config.url;
    };

    this.getTransport = function() {
        return _transport;
    };

    this.getConfiguration = function() {
        return this._mixin(true, {}, _config);
    };

    this.getAdvice = function() {
        return this._mixin(true, {}, _advice);
    };
};
