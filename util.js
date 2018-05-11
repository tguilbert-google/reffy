/**
 * A bunch of utility functions common to multiple scripts
 */

const path = require('path');
const URL = require('url');
const baseFetch = require('fetch-filecache-for-crawling');
const respecWriter = require("respec/tools/respecDocWriter").fetchAndWrite;


/**
 * Wrapper around the "require" function to require files relative to the
 * current working directory (CWD), instead of relative to the current JS
 * file.
 *
 * This is typically needed to be able to use "require" to load JSON config
 * files provided as command-line arguments.
 *
 * @function
 * @param {String} filename The path to the file to require
 * @return {Object} The result of requiring the file relative to the current
 *   working directory.
 */
function requireFromWorkingDirectory(filename) {
    return require(path.resolve(filename));
}

// Read configuration parameters from `config.json` file
let config = null;
try {
    config = requireFromWorkingDirectory('config.json');
}
catch (err) {
    config = {};
}


/**
 * Fetch function that applies fetch parameters defined in `config.json`
 * unless parameters are already set.
 *
 * By default, force the HTTP refresh strategy to "once", so that only one
 * HTTP request gets sent on a given URL per crawl.
 *
 * @function
 * @param {String} url URL to fetch
 * @param {Object} options Fetch options (and options for node-fetch, and
 *   options for fetch-filecache-for-crawling)
 * @return {Promise(Response)} Promise to get an HTTP response
 */
function fetch(url, options) {
    options = Object.assign({}, options);
    ['cacheFolder', 'resetCache', 'cacheRefresh', 'logToConsole'].forEach(param => {
        let fetchParam = (param === 'cacheRefresh') ? 'refresh' : param;
        if (config[param] && !options.hasOwnProperty(fetchParam)) {
            options[fetchParam] = config[param];
        }
    });
    if (!options.refresh) {
        options.refresh = 'once';
    }
    return baseFetch(url, options);
}


////////////////////////////////////////////////////////////////////////////////
// UGLY CODE WARNING
//
// JSDOM no longer exposes any mechanism to provide one's own resource loader,
// which is a pity, because we need it! The next few lines are a horrible hack
// to intercept HTTP requests made by JSDOM so that we can:
// 1. filter those we're not interested in (e.g. requests to stylesheets and
// non-essential scripts)
// 2. use our local HTTP cache so that we download resources only once
//
// The hack overrides the `download` method of the `resourceLoader` module in
// JSDOM so that further calls to `require` on that module use our version.
// This is as ugly as code can get but it works.

// NB: this may well break when switching to a new version of JSDOM (but then,
// hopefully, it will soon be again possible to provide one's own resource
// loader to JSDOM...)
////////////////////////////////////////////////////////////////////////////////
const resourceLoader = require('jsdom/lib/jsdom/browser/resource-loader');
resourceLoader.download = function (url, options, callback) {
    // Restrict resource loading to ReSpec and script resources that sit next
    // to the spec under test, excluding scripts of WebIDL as well as the
    // WHATWG annotate_spec script that JSDOM does not seem to like.
    // Explicitly whitelist the "autolink" script of the shadow DOM spec which
    // is needed to initialize respecConfig
    function getUrlToFetch() {
        let referrer = options.referrer;
        if (!referrer.endsWith('/')) {
            referrer = referrer.substring(0, referrer.lastIndexOf('/') + 1);
        }
        if (/\/respec[\/\-]/i.test(url.path)) {
            console.log(`fetch ReSpec (force latest version)`);
            return 'https://www.w3.org/Tools/respec/respec-w3c-common';
        }
        else if (/\.[^\/\.]+$/.test(url.path) &&
                !url.path.endsWith('.js') &&
                !url.path.endsWith('.json')) {
            console.log(`fetch not needed for ${url.href} (not a JS/JSON file)`);
            return null;
        }
        else if ((url.pathname === '/webcomponents/assets/scripts/autolink.js') ||
            (url.href.startsWith(referrer) &&
                !(/annotate_spec/i.test(url.pathname)) &&
                !(/expanders/i.test(url.pathname)) &&
                !(/bug-assist/i.test(url.pathname)) &&
                !(/dfn/i.test(url.pathname)) &&
                !(/section-links/i.test(url.pathname)) &&
                !(/^\/webidl\//i.test(url.pathname)))) {
            console.log(`fetch useful script at ${url.href}`);
            return url.href;
        }
        console.log(`fetch not needed for ${url.href}`);
        return null;
    }

    let urlToFetch = getUrlToFetch();
    if (!urlToFetch) {
        return callback(null, '');
    }
    fetch(urlToFetch, options)
        .then(response => response.text())
        .then(data => {
            if (urlToFetch !== 'https://www.w3.org/Tools/respec/respec-w3c-common') {
                return data;
            }

            // Tweak Respec code so that it runs in JSDOM
            // Remove core/highlight module because JSDOM does not yet
            // support URL.createObjectURL
            // https://github.com/jsdom/jsdom/issues/1721
            ["core/highlight"].forEach(module => data = data.replace(
                new RegExp('(define\\(\\s*"profile-w3c-common"\\s*,\\s*\\[[^\\]]+),\\s*"' + module + '"'),
                '$1'));

            // JSDOM's CSS parser does not quite like uncommon "@" rules
            // so let's pretend they are just @media rules
            // https://github.com/jsdom/jsdom/issues/2026
            data = data.replace(/@keyframes \S+? {/, '@media all {');
            data = data.replace(/@supports \(.+?\) {/, '@media all {');

            // JSDOM does not yet support innerText. Only used in Respec
            // to set text of empty elements, so replacing with
            // textContent should be good enough
            // https://github.com/jsdom/jsdom/issues/1245
            data = data.replace(/\.innerText=/g, '.textContent=');
            data = data.replace(/body\.innerText/g, 'body.textContent');
            return data;
        })
        .then(data => callback(null, data))
        .catch(err => callback(err));
};

// That's it, JSDOM will now use our `download` function.
const { JSDOM } = require('jsdom');


/**
 * Load the given HTML.
 *
 * @function
 * @public
 * @param {Object} spec The spec to load. Must contain an "html" property with
 *   the HTML contents to load. May also contain an "url" property with the URL
 *   of the document (defaults to "about:blank"), and a "responseUrl" property
 *   with the final URL of the document (which may differ from the initial URL
 *   in case there were redirects and which defaults to the value of the "url"
 *   property)
 * @param {Number} counter Optional loop counter parameter to detect infinite
 *   loop. The parameter is mostly meant to be an internal parameter, set and
 *   incremented between calls when dealing with redirections. There should be
 *   no need to set that parameter when calling that function externally.
 * @return {Promise} The promise to get a window object once the spec has
 *   been loaded with jsdom.
 */
async function loadSpecificationFromHtml(spec, counter) {
    let url = spec.url || 'about:blank';
    let responseUrl = spec.responseUrl || url;
    let html = spec.html || '';
    counter = counter || 0;

    let promise = new Promise((resolve, reject) => {
        // Drop Byte-Order-Mark character if needed, it bugs JSDOM
        if (html.charCodeAt(0) === 0xFEFF) {
            html = html.substring(1);
        }
        const {window} = new JSDOM(html, {
            url: responseUrl,
            resources: 'usable',
            runScripts: 'dangerously',
            beforeParse(window) {
                // Wait until the generation of Respec documents is over
                window.addEventListener('load', function () {
                    let usesRespec = window.respecConfig &&
                        window.document.head.querySelector("script[src*='respec']");
                    let resolveWhenReady = _ => {
                        if (window.document.respecIsReady) {
                            window.document.respecIsReady
                                .then(_=> resolve(window))
                                .catch(reject);
                        }
                        else if (usesRespec) {
                            setTimeout(resolveWhenReady, 100);
                        }
                        else {
                            resolve(window);
                        }
                    }
                    resolveWhenReady();
                });

                // Not yet supported in JSDOM
                // https://github.com/jsdom/jsdom/issues/1890
                window.Element.prototype.insertAdjacentElement =
                    window.Element.prototype.insertAdjacentElement ||
                    function (position, element) {
                        switch (position.toLowerCase()) {
                            case 'beforebegin':
                                this.parentElement.insertBefore(element, this);
                                break;
                            case 'afterbegin':
                                if (this.firstChild) {
                                    this.insertBefore(element, this.firstChild);
                                } else {
                                    this.appendChild(element);
                                }
                                break;
                            case 'beforeend':
                                this.appendChild(element);
                                break;
                            case 'afterend':
                                this.parentElement.appendChild(element);
                                this.after(element);
                                break;
                        }
                        return element;
                    };

                // Not yet supported in JSDOM
                // https://github.com/jsdom/jsdom/issues/1555
                window.Element.prototype.closest =
                    window.Element.prototype.closest ||
                    function (selector) {
                        var el = this;
                        if (!this.ownerDocument.documentElement.contains(el)) return null;
                        do {
                            if (el.matches(selector)) return el;
                            el = el.parentElement || el.parentNode;
                        } while (el !== null && el.nodeType === 1);
                        return null;
                    };

                // Not yet supported in JSDOM for attributes
                // (but needed by HyperHTML)
                // https://github.com/jsdom/jsdom/commit/acf0156b563b5e2ba606da36fd597e0a0b344f5a
                window.Attr.prototype.cloneNode =
                    window.Attr.prototype.cloneNode ||
                    function () {
                        if (!this.ownerDocument) {
                            // Not sure how this can happen, but it does happen :(
                            // Not much we can do about it except returning the
                            // attribute without cloning it (returning null crashes)
                            return this;
                        }
                        return this.ownerDocument.createAttributeNS(
                            this.namespaceURI, this.name, this.value);
                    };

                // Not yet supported in JSDOM
                // https://github.com/jsdom/jsdom/blob/master/test/web-platform-tests/to-upstream/html/browsers/the-window-object/window-properties-dont-upstream.html#L104
                window.matchMedia =
                    window.matchMedia ||
                    function () {
                        return {
                            matches: false,
                            addListener: () => {},
                            removeListener: () => {},
                            onchange: () => {}
                        };
                    };

                // Not yet supported in JSDOM
                // (and actually, good for us since we want to control caching
                // logic here)
                // https://github.com/jsdom/jsdom/issues/1724
                window.fetch = function (url, options) {
                    if (!url.startsWith('http:') || !url.startsWith('https:')) {
                        let a = window.document.createElement('a');
                        a.href = url;
                        url = a.href;
                    }
                    return fetch(url, options);
                };

                // Not yet supported in JSDOM
                // (most are not used in our specs, but some still call "scrollBy")
                // https://github.com/jsdom/jsdom/blob/master/lib/jsdom/browser/Window.js#L570
                ['blur', 'focus', 'moveBy', 'moveTo', 'resizeBy', 'resizeTo', 'scroll', 'scrollBy', 'scrollTo']
                    .forEach(method => window[method] = function () {});
            }
        });
    });

    return promise.then(window => {
        let doc = window.document;

        // Handle <meta http-equiv="refresh"> redirection
        // Note that we'll assume that the number in "content" is correct
        let metaRefresh = doc.querySelector('meta[http-equiv="refresh"]');
        if (metaRefresh) {
            let redirectUrl = (metaRefresh.getAttribute('content') || '').split(';')[1];
            if (redirectUrl) {
                redirectUrl = URL.resolve(doc.baseURI, redirectUrl.trim());
                if ((redirectUrl !== url) && (redirectUrl !== responseUrl)) {
                    return loadSpecificationFromUrl(redirectUrl, counter + 1);
                }
            }
        }

        const links = doc.querySelectorAll('body .head dl a[href]');
        for (let i = 0 ; i < links.length; i++) {
            let link = links[i];
            let text = (link.textContent || '').toLowerCase();
            if (text.includes('single page') ||
                text.includes('single file') ||
                text.includes('single-page') ||
                text.includes('one-page')) {
                let singlePage = URL.resolve(doc.baseURI, link.getAttribute('href'));
                if ((singlePage === url) || (singlePage === responseUrl)) {
                    // We're already looking at the single page version
                    return window;
                }
                else {
                    return loadSpecificationFromUrl(singlePage, counter + 1);
                }
                return;
            }
        }
        return window;
    });
}


/**
 * Load the specification at the given URL.
 *
 * @function
 * @public
 * @param {String} url The URL of the specification to load
 * @param {Number} counter Optional loop counter parameter to detect infinite
 *   loop. The parameter is mostly meant to be an internal parameter, set and
 *   incremented between calls when dealing with redirections. There should be
 *   no need to set that parameter when calling that function externally.
 * @return {Promise} The promise to get a window object once the spec has
 *   been loaded with jsdom.
 */
function loadSpecificationFromUrl(url, counter) {
    counter = counter || 0;
    if (counter >= 5) {
        return new Promise((resolve, reject) => {
            reject(new Error('Infinite loop detected'));
        });
    }
    return fetch(url)
        .then(response => response.text().then(html => {
            return { url, html, responseUrl: response.url };
        }))
        .then(spec => loadSpecificationFromHtml(spec, counter));
}


/**
 * Load the given specification.
 *
 * @function
 * @public
 * @param {String|Object} spec The URL of the specification to load or an object
 *   with an "html" key that contains the HTML to load (and an optional "url"
 *   key to force the URL in the loaded DOM)
 * @return {Promise} The promise to get a window object once the spec has
 *   been loaded with jsdom.
 */
function loadSpecification(spec) {
    spec = (typeof spec === 'string') ? { url: spec } : spec;
    return (spec.html ?
        loadSpecificationFromHtml(spec) :
        loadSpecificationFromUrl(spec.url));
}

function urlOrDom(input) {
    if (typeof input === "string") {
        return loadSpecification(input);
    } else {
        return Promise.resolve(input);
    }
}

/**
 * Given a "window" object loaded with jsdom, retrieve the document along
 * with the name of the well-known generator that was used, if known.
 *
 * Note that the function only returns when the document is properly generated
 * (typically, once ReSpec is done generating the document if the spec being
 * considered is a raw ReSpec document)
 *
 * @function
 * @public
 * @param {Window} window
 * @return {Promise} The promise to get a document ready for extraction and
 *   the name of the generator (or null if generator is unknown).
 */
function getDocumentAndGenerator(window) {
    return new Promise(function (resolve, reject) {
        var doc = window.document;
        var generator = window.document.querySelector("meta[name='generator']");
        var timeout = null;
        if (generator && generator.content.match(/bikeshed/i)) {
            resolve({doc, generator:'bikeshed'});
        } else if (doc.body.id === "respecDocument") {
            resolve({doc, generator:'respec'});
        } else if (window.respecConfig &&
            window.document.head.querySelector("script[src*='respec']")) {
            if (!window.respecConfig.postProcess) {
                window.respecConfig.postProcess = [];
            }
            window.respecConfig.postProcess.push(function() {
                if (timeout) {
                    clearTimeout(timeout);
                }
                resolve({doc, generator: 'respec'});
            });
            timeout = setTimeout(function () {
              reject(new Error('Specification apparently uses ReSpec but document generation timed out'));
            }, 30000);
        } else if (doc.getElementById('anolis-references')) {
            resolve({doc, generator: 'anolis'});
        } else {
            resolve({doc});
        }
    });
}

module.exports.fetch = fetch;
module.exports.requireFromWorkingDirectory = requireFromWorkingDirectory;
module.exports.loadSpecification = loadSpecification;
module.exports.urlOrDom = urlOrDom;
module.exports.getDocumentAndGenerator = getDocumentAndGenerator;