const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Map of texts we want to translate. We can just generate hashes or use camelcase keys
const translationMap = {
  en: {},
  zh: {}
};

function processFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  let changed = false;

  // We need to inject useTranslation if it has translatable strings.
  // But regexing JSX is hard.
  // Let's just create a list of exact replacements.
}
