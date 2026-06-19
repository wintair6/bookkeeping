process.env.ENCRYPTION_KEY = 'a'.repeat(64); // 32-byte hex

const { encrypt, decrypt } = require('../../src/services/encryptor');

test('round-trip encrypt/decrypt', () => {
  const plain = 'my-api-key-12345';
  const stored = encrypt(plain);
  expect(decrypt(stored)).toBe(plain);
});

test('encrypted value is not plaintext', () => {
  const stored = encrypt('secret');
  expect(stored).not.toContain('secret');
});

test('encrypted value includes key version prefix', () => {
  const stored = encrypt('x');
  expect(stored.startsWith('1:')).toBe(true);
});

test('decrypt throws on tampered ciphertext', () => {
  const stored = encrypt('hello');
  const parts = stored.split(':');
  parts[3] = 'deadbeef'.repeat(4); // corrupt ciphertext
  expect(() => decrypt(parts.join(':'))).toThrow();
});
