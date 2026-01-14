export function base64FromBytes(bytes: Uint8Array) {
  const lookup = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let bin = '';
  const len = bytes.length;
  let i;
  for (i = 0; i < len; i += 3) {
    const a = bytes[i];
    const b = i + 1 < len ? bytes[i + 1] : 0;
    const c = i + 2 < len ? bytes[i + 2] : 0;
    const triple = (a << 16) + (b << 8) + c;
    bin += lookup[(triple >> 18) & 0x3f];
    bin += lookup[(triple >> 12) & 0x3f];
    bin += i + 1 < len ? lookup[(triple >> 6) & 0x3f] : '=';
    bin += i + 2 < len ? lookup[triple & 0x3f] : '=';
  }
  return bin;
}

export function base64ToBytes(b64: string) {
  try {
    if (typeof atob === 'function') {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return arr;
    }
  } catch (e) {
    // fall through to Buffer
  }
  if (typeof Buffer !== 'undefined') {
    return Uint8Array.from(Buffer.from(b64, 'base64'));
  }
  return new Uint8Array([]);
}
