'use strict';

const session = require('express-session');
const storage = require('./storage');

class PackageStore extends session.Store {
  get(sid, cb) {
    storage
      .sessionGet(sid)
      .then((data) => cb(null, data))
      .catch((err) => cb(err));
  }

  set(sid, sess, cb) {
    storage
      .sessionSet(sid, sess, sess && sess.cookie && sess.cookie.maxAge)
      .then(() => cb(null))
      .catch((err) => cb(err));
  }

  destroy(sid, cb) {
    storage
      .sessionDestroy(sid)
      .then(() => cb(null))
      .catch((err) => cb(err));
  }

  touch(sid, sess, cb) {
    storage
      .sessionTouch(sid, sess && sess.cookie && sess.cookie.maxAge)
      .then(() => cb(null))
      .catch((err) => cb(err));
  }
}

module.exports = PackageStore;