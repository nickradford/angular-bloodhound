/*
 * typeahead.js
 * https://github.com/twitter/typeahead.js
 * Copyright 2013-2014 Twitter, Inc. and other contributors; Licensed MIT
 */
(function() {
  'use strict';

  var module = angular.module('bloodhound', ['bloodhound.tokenizers', 'bloodhound.options-parser', 'bloodhound.search-index', 'bloodhound.persistent-storage', 'bloodhound.transport']);

  module.factory('Bloodhound', function($rootScope, $q, $http, tokenizers, oParser, SearchIndex, PersistentStorage, Transport) {
    var Bloodhound = (function() {
      var old, keys;

      keys = { data: 'data', protocol: 'protocol', thumbprint: 'thumbprint' };

      // constructor
      // -----------

      function Bloodhound(o) {
        if (!o || (!o.local && !o.prefetch && !o.remote)) {
          throw new Error('one of local, prefetch, or remote is required');
          //$.error('one of local, prefetch, or remote is required');
        }

        this.limit = o.limit || 5;
        this.sorter = getSorter(o.sorter);
        this.dupDetector = o.dupDetector || ignoreDuplicates;

        this.local = oParser.local(o);
        this.prefetch = oParser.prefetch(o);
        this.remote = oParser.remote(o);

        this.cacheKey = this.prefetch ?
          (this.prefetch.cacheKey || this.prefetch.url) : null;

        // the backing data structure used for fast pattern matching
        this.index = new SearchIndex({
          datumTokenizer: o.datumTokenizer,
          queryTokenizer: o.queryTokenizer
        });

        // only initialize storage if there's a cacheKey otherwise
        // loading from storage on subsequent page loads is impossible
        this.storage = this.cacheKey ? new PersistentStorage(this.cacheKey) : null;
      }

      // static methods
      // --------------

      Bloodhound.tokenizers = tokenizers;

      // instance methods
      // ----------------

      angular.extend(Bloodhound.prototype, {

        // ### private

        _loadPrefetch: function loadPrefetch(o) {
          var that = this, serialized, promise;

          if (serialized = this._readFromStorage(o.thumbprint)) {
            this.index.bootstrap(serialized);
            var deferred = $q.defer();
            deferred.resolve();
            promise = deferred.promise;
            //deferred = $.Deferred().resolve();
          }

          else {
            promise = $http.get(o.url, o.ajax).success(handlePrefetchResponse);
            //deferred = $.ajax(o.url, o.ajax).done(handlePrefetchResponse);
          }

          return promise;

          function handlePrefetchResponse(resp) {
            // clear to mirror the behavior of bootstrapping
            that.clear();
            that.add(o.filter ? o.filter(resp) : resp);

            that._saveToStorage(that.index.serialize(), o.thumbprint, o.ttl);
          }
        },

        _getFromRemote: function getFromRemote(query, cb) {
          var that = this, url, uriEncodedQuery;

          query = query || '';
          uriEncodedQuery = encodeURIComponent(query);

          url = this.remote.replace ?
            this.remote.replace(this.remote.url, query) :
            this.remote.url.replace(this.remote.wildcard, uriEncodedQuery);

          return this.transport.get(url, this.remote.ajax, handleRemoteResponse);

          function handleRemoteResponse(err, resp) {
            err ? cb([]) : cb(that.remote.filter ? that.remote.filter(resp) : resp);
          }
        },

        _saveToStorage: function saveToStorage(data, thumbprint, ttl) {
          if (this.storage) {
            this.storage.set(keys.data, data, ttl);
            this.storage.set(keys.protocol, location.protocol, ttl);
            this.storage.set(keys.thumbprint, thumbprint, ttl);
          }
        },

        _readFromStorage: function readFromStorage(thumbprint) {
          var stored = {}, isExpired;

          if (this.storage) {
            stored.data = this.storage.get(keys.data);
            stored.protocol = this.storage.get(keys.protocol);
            stored.thumbprint = this.storage.get(keys.thumbprint);
          }
          // the stored data is considered expired if the thumbprints
          // don't match or if the protocol it was originally stored under
          // has changed
          isExpired = stored.thumbprint !== thumbprint ||
            stored.protocol !== location.protocol;

          return stored.data && !isExpired ? stored.data : null;
        },

        _initialize: function initialize() {
          var that = this, local = this.local, promise;

          if (this.prefetch) {
            promise = this._loadPrefetch(this.prefetch);
          } else {
            var deferred = $q.defer();
            deferred.resolve();
            promise = deferred.promise;
          }

          /*
          promise = this.prefetch ?
            this._loadPrefetch(this.prefetch) : $.Deferred().resolve();
          */

          // make sure local is added to the index after prefetch
          local && promise.then(addLocalToIndex);

          this.transport = this.remote ? new Transport(this.remote) : null;

          return (this.initPromise = promise);

          function addLocalToIndex() {
            // local can be a function that returns an array of datums
            that.add(angular.isFunction(local) ? local() : local);
          }
        },

        // ### public

        initialize: function initialize(force) {
          return !this.initPromise || force ? this._initialize() : this.initPromise;
        },

        add: function add(data) {
          this.index.add(data);
        },

        get: function get(query, cb) {
          var that = this, matches = [], cacheHit = false;

          matches = this.index.get(query);
          matches = this.sorter(matches).slice(0, this.limit);

          if (matches.length < this.limit && this.transport) {
            cacheHit = this._getFromRemote(query, returnRemoteMatches);
          }

          // if a cache hit occurred, skip rendering local matches
          // because the rendering of local/remote matches is already
          // in the event loop
          if (!cacheHit) {
            // only render if there are some local suggestions or we're
            // going to the network to backfill
            (matches.length > 0 || !this.transport) && cb && cb(matches);
          }

          function returnRemoteMatches(remoteMatches) {
            var matchesWithBackfill = matches.slice(0);

            angular.forEach(remoteMatches, function(remoteMatch) {
              var isDuplicate;

              // checks for duplicates
              isDuplicate = matchesWithBackfill.some(function(match) {
                return that.dupDetector(remoteMatch, match);
              });

              !isDuplicate && matchesWithBackfill.push(remoteMatch);

              // if we're at the limit, we no longer need to process
              // the remote results and can break out of the each loop
              return matchesWithBackfill.length < that.limit;
            });
            cb && cb(that.sorter(matchesWithBackfill));
          }
        },

        clear: function clear() {
          this.index.reset();
        },

        clearPrefetchCache: function clearPrefetchCache() {
          this.storage && this.storage.clear();
        },

        clearRemoteCache: function clearRemoteCache() {
          this.transport && Transport.resetCache();
        }
      });

      return Bloodhound;

      // helper functions
      // ----------------

      function getSorter(sortFn) {
        return angular.isFunction(sortFn) ? sort : noSort;

        function sort(array) { return array.sort(sortFn); }
        function noSort(array) { return array; }
      }

      function ignoreDuplicates() { return false; }
    })();

    return Bloodhound;
  });
})();
