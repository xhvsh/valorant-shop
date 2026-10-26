'use strict';

const nacl = require('tweetnacl');

function keyFrom(publicKey) {
  if (typeof publicKey === 'string') {
    if (publicKey.length === 64 && /^[0-9a-fA-F]+$/.test(publicKey)) {
      return Buffer.from(publicKey, 'hex');
    }
    return Buffer.from(publicKey, 'base64');
  }
  if (Buffer.isBuffer(publicKey) && publicKey.length === 32) return publicKey;
  if (publicKey && publicKey.length === 32 && Array.isArray(publicKey)) return Buffer.from(publicKey);
  return null;
}

function verifyRequest(publicKey, signature, timestamp, rawBodyBuffer) {
  const key = keyFrom(publicKey);
  const sig = Buffer.from(String(signature || ''), 'hex');
  if (!key || key.length !== 32 || sig.length !== 64) return false;
  const raw = Buffer.isBuffer(rawBodyBuffer) ? rawBodyBuffer : Buffer.from(String(rawBodyBuffer || ''));
  const msg = Buffer.concat([Buffer.from(String(timestamp || '')), raw]);
  try {
    return nacl.sign.detached.verify(msg, sig, key);
  } catch {
    return false;
  }
}

module.exports = { verifyRequest };