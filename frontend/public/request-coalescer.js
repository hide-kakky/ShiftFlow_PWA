(function exposeRequestCoalescer(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.ShiftFlowRequestCoalescer = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildRequestCoalescer() {
  'use strict';

  function stableSerialize(value) {
    var seen = typeof WeakSet === 'function' ? new WeakSet() : null;

    function serialize(entry) {
      if (entry === null) return 'null';
      var type = typeof entry;
      if (type === 'string' || type === 'boolean') return JSON.stringify(entry);
      if (type === 'number') return Number.isFinite(entry) ? String(entry) : 'null';
      if (type === 'undefined') return '"[undefined]"';
      if (type !== 'object') return JSON.stringify(String(entry));
      if (seen) {
        if (seen.has(entry)) throw new TypeError('循環参照はrequest keyに使用できません。');
        seen.add(entry);
      }
      var serialized;
      if (Array.isArray(entry)) {
        serialized = '[' + entry.map(serialize).join(',') + ']';
      } else {
        serialized =
          '{' +
          Object.keys(entry)
            .sort()
            .map(function (key) {
              return JSON.stringify(key) + ':' + serialize(entry[key]);
            })
            .join(',') +
          '}';
      }
      if (seen) seen.delete(entry);
      return serialized;
    }

    return serialize(value);
  }

  function createRequestCoalescer() {
    var inFlight = new Map();
    var generationState = { reason: '' };

    function invalidatedError(reason) {
      var error = new Error('進行中のread requestは新しい状態により無効化されました。');
      error.code = 'REQUEST_COALESCER_CLEARED';
      error.reason = String(reason || 'manual');
      return error;
    }

    return {
      run: function run(key, factory) {
        var normalizedKey = String(key || '');
        if (!normalizedKey) return Promise.resolve().then(factory);
        if (inFlight.has(normalizedKey)) return inFlight.get(normalizedKey);
        var requestGeneration = generationState;
        var promise = Promise.resolve()
          .then(factory)
          .then(function (value) {
            if (requestGeneration !== generationState) {
              throw invalidatedError(requestGeneration.reason);
            }
            return value;
          });
        inFlight.set(normalizedKey, promise);
        var clear = function () {
          if (inFlight.get(normalizedKey) === promise) inFlight.delete(normalizedKey);
        };
        promise.then(clear, clear);
        return promise;
      },
      clear: function clear(reason) {
        generationState.reason = String(reason || 'manual');
        generationState = { reason: '' };
        inFlight.clear();
      },
      size: function size() {
        return inFlight.size;
      },
    };
  }

  return {
    stableSerialize: stableSerialize,
    createRequestCoalescer: createRequestCoalescer,
  };
});
