import getTitle from './get-title.js';
import getGenerator from './get-generator.js';
import getLastModifiedDate from './get-lastmodified-date.js';
import extractWebIdl from './extract-webidl.js';
import extractCSS from './extract-cssdfn.js';
import extractReferences from './extract-references.js';
import extractLinks from './extract-links.js';
import { canonicalizeUrl, canonicalizesTo } from './canonicalize-url.js';


// Create a namespace to expose all Reffy functions if needed,
// and expose all functions there.
window.reffy = Object.assign(
  window.reffy || {},
  {
    getTitle,
    getGenerator,
    getLastModifiedDate,
    extractWebIdl,
    extractCSS,
    extractReferences,
    extractLinks,
    canonicalizeUrl,
    canonicalizesTo
  }
);