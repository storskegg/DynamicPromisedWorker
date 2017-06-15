export default class DynamicPromisedWorker {
  constructor(fn, singleFire = false) {
    if (typeof fn !== "function") {
      throw new Error("DynamicPromisedWorker must be passed a valid function.");
    }

    this.messageIds = 0;
    this.singleFire = !!singleFire;

    this._handlers = new Map();
    this._worker = this.makeWorker(fn);

    this._worker.addEventListener("message", e => {
      this.onMessage(e);
    });
  }

  makeWorker(fn) {
    // The following method isn't for calling. No touchy.
    function _promisedWorker(callback) {
      function parseJSON(str) {
        try {
          return JSON.parse(str);
        } catch (e) {
          return false;
        }
      }

      function postMsg(e, messageId, err, result) {
        function postMessage(msg) {
          if (typeof self.postMessage !== "function") {
            // service worker
            e.ports[0].postMessage(msg);
          } else {
            // web worker
            self.postMessage(msg);
          }
        }
        if (err) {
          console.error("Worker caught an error:", err);
          postMessage(
            JSON.stringify([
              messageId,
              {
                message: err.message
              }
            ])
          );
        } else {
          postMessage(JSON.stringify([messageId, null, result]));
        }
      }

      function safeExec(callback, message) {
        try {
          return { res: callback(message) };
        } catch (e) {
          return { err: e };
        }
      }

      function doMsgIn(e, callback, messageId, message) {
        const result = safeExec(callback, message);

        if (result.err) {
          postMsg(e, messageId, result.err);
        } else if (typeof result.res.then !== "function") {
          postMsg(e, messageId, null, result.res);
        } else {
          result.res.then(
            finalResult => {
              postMsg(e, messageId, null, finalResult);
            },
            finalError => {
              postMsg(e, messageId, finalError);
            }
          );
        }
      }

      function onMsgIn(e) {
        const payload = parseJSON(e.data);
        if (!payload || !Array.isArray(payload)) {
          return;
        }
        const [messageId, message] = payload;

        doMsgIn(e, callback, messageId, message);
      }

      self.addEventListener("message", onMsgIn);
    }

    const fnString = `(function(){'use strict';${this._promisedWorker.toString()} _promisedWorker(${fn.toString()});}())`;
    return new Worker(
      URL.createObjectURL(
        new Blob([fnString], { type: "application/javascript" })
      )
    );
  }

  onMessage(e) {
    const message = this.parseJSON(e.data);
    if (!message || !Array.isArray(message)) {
      return;
    }

    const [messageId, error, result] = message;

    const callback = this._handlers.get(messageId);
    if (!callback) {
      return;
    }

    this._handlers.delete(messageId);
    callback(error, result);

    if (this.singleFire) {
      this._worker.terminate();
    }
  }

  parseJSON(s) {
    try {
      return JSON.parse(s);
    } catch (e) {
      return false;
    }
  }

  postMessage(msg) {
    const messageId = this.messageIds++;
    const msg2Send = [messageId, msg];

    return new Promise((resolve, reject) => {
      this._handlers.set(messageId, (err, result) => {
        if (err) {
          return reject(new Error(err.message));
        }
        resolve(result);
      });

      try {
        const jsonMsg = JSON.stringify(msg2Send);

        if (typeof this._worker.controller !== "undefined") {
          const channel = new MessageChannel();
          channel.port1.onmessage = function(e) {
            this.onMessage(e);
          };
          this._worker.controller.postMessage(jsonMsg, [channel.port2]);
        } else {
          this._worker.postMessage(jsonMsg);
        }
      } catch (err) {
        return reject(new Error(err.message));
      }
    });
  }
}
