const { buildFilename } = require('../../src/services/renamer');

// Minimal DB mock
function makeDb(existingNames = []) {
  return {
    prepare: () => ({
      all: () => existingNames.map(renamed_filename => ({ renamed_filename })),
    }),
  };
}

test('basic filename', () => {
  expect(buildFilename('2026-01-15', 'Amazon GmbH', makeDb())).toBe('2026-01-15-amazon-gmbh.pdf');
});

test('sanitises special chars', () => {
  expect(buildFilename('2026-01-15', 'AT&T / Telekom', makeDb())).toBe('2026-01-15-at-t-telekom.pdf');
});

test('appends -2 on first duplicate', () => {
  const db = makeDb(['2026-01-15-amazon.pdf']);
  expect(buildFilename('2026-01-15', 'Amazon', db)).toBe('2026-01-15-amazon-2.pdf');
});

test('appends -3 on second duplicate', () => {
  const db = makeDb(['2026-01-15-amazon.pdf', '2026-01-15-amazon-2.pdf']);
  expect(buildFilename('2026-01-15', 'Amazon', db)).toBe('2026-01-15-amazon-3.pdf');
});

test('collapses multiple spaces/hyphens', () => {
  expect(buildFilename('2026-01-15', 'foo   --  bar', makeDb())).toBe('2026-01-15-foo-bar.pdf');
});
