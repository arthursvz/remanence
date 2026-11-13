'use strict';

/**
 * Rémanence mobile : licences, paquet, progression (WebCrypto seul). Formats décrits dans src/core/remmobile.js.
 * Tourne dans la page du téléphone (window.RemCrypto) et sous Node pour les tests.
 */
(function (global, factory) {
  const api = factory(global.crypto && global.crypto.subtle ? global.crypto : require('node:crypto').webcrypto);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.RemCrypto = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, (wc) => {
  const subtle = wc.subtle;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const fromB64u = (s) => {
    const b = String(s).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b + '='.repeat((4 - (b.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  const toB64u = (u8) => {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const fromB64 = (s) => fromB64u(String(s).replace(/=+$/, ''));

  class RemError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  /** Vérifie la signature (Ed25519, clé publique de la licence Dawn) ; renvoie la charge, péremption non vérifiée. */
  async function parseLicence(token, pubB64) {
    const t = String(token || '').trim().replace(/^.*#lic=/, '');
    const m = /^rml1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(t);
    if (!m) throw new RemError('BAD_LICENCE', 'Ce n’est pas une licence Rémanence.');
    let key;
    try {
      key = await subtle.importKey('spki', fromB64(pubB64), { name: 'Ed25519' }, false, ['verify']);
    } catch {
      throw new RemError('NO_ED25519', 'Ce navigateur ne sait pas vérifier les licences (Ed25519). Mets à jour Chrome.');
    }
    const ok = await subtle.verify({ name: 'Ed25519' }, key, fromB64u(m[2]), enc.encode(`rml1.${m[1]}`));
    if (!ok) throw new RemError('BAD_SIGNATURE', 'Licence invalide : signature incorrecte.');
    const lic = JSON.parse(dec.decode(fromB64u(m[1])));
    if (lic.v !== 1 || !lic.id || !lic.ch || !lic.k || !Number.isFinite(lic.exp)) throw new RemError('BAD_LICENCE', 'Licence incomplète.');
    return { ...lic, token: t };
  }

  /** Clé AES non extractable : elle peut être rangée telle quelle dans IndexedDB sans que ses octets soient lisibles. */
  const aesKey = (b64u) => subtle.importKey('raw', fromB64u(b64u), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

  function head(magic, buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (u8.length < 9 || dec.decode(u8.subarray(0, 4)) !== magic || u8[4] !== 1) throw new RemError('BAD_FILE', magic === 'RMPG' ? 'Ce fichier n’est pas une progression Rémanence.' : 'Paquet Rémanence illisible.');
    const n = new DataView(u8.buffer, u8.byteOffset + 5, 4).getUint32(0, true);
    const h = u8.subarray(9, 9 + n);
    return { u8, h, header: JSON.parse(dec.decode(h)), ct: u8.subarray(9 + n) };
  }

  async function open(magic, buf, key) {
    const { h, header, ct } = head(magic, buf);
    try {
      return { header, plain: new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: fromB64u(header.iv), additionalData: h }, key, ct)) };
    } catch {
      throw new RemError('BAD_KEY', 'Déchiffrement impossible : licence d’un autre canal, ou fichier abîmé.');
    }
  }

  const packHeader = (buf) => head('RMPK', buf).header;

  /** { header, data: { doc, fiches, cards, owner }, pdf } */
  async function openPack(buf, key) {
    const { header, plain } = await open('RMPK', buf, key);
    const n = new DataView(plain.buffer, plain.byteOffset, 4).getUint32(0, true);
    return { header, data: JSON.parse(dec.decode(plain.subarray(4, 4 + n))), pdf: plain.subarray(4 + n) };
  }

  /** Planning du propriétaire, chiffré à part dans le paquet. */
  async function openOwner(box, okey, packId) {
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64u(box.iv), additionalData: enc.encode(`rem-owner/v1|${packId}`) }, okey, fromB64u(box.ct));
    return JSON.parse(dec.decode(pt));
  }

  async function seal(magic, header, key, plain) {
    const iv = wc.getRandomValues(new Uint8Array(12));
    const h = enc.encode(JSON.stringify({ ...header, iv: toB64u(iv) }));
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: h }, key, plain));
    const out = new Uint8Array(9 + h.length + ct.length);
    out.set(enc.encode(magic), 0);
    out[4] = 1;
    new DataView(out.buffer).setUint32(5, h.length, true);
    out.set(h, 9);
    out.set(ct, 9 + h.length);
    return out;
  }

  /** Fichier de progression : { log, cfg } chiffré avec la clé du canal. */
  const sealProgress = (key, header, obj) => seal('RMPG', header, key, enc.encode(JSON.stringify(obj)));
  const progressHeader = (buf) => head('RMPG', buf).header;
  async function openProgress(buf, key) {
    const { header, plain } = await open('RMPG', buf, key);
    return { header, data: JSON.parse(dec.decode(plain)) };
  }

  return { RemError, parseLicence, aesKey, packHeader, openPack, openOwner, sealProgress, progressHeader, openProgress, fromB64u, toB64u };
});
