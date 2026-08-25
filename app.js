// Set up the 'Enter' key search listener on load
document.getElementById('searchInput').addEventListener('keypress', function (event) {
    if (event.key === 'Enter') {
        event.preventDefault();
        runSearch();
    }
});

// Extension pages (and any page with a strict Content-Security-Policy) disallow
// inline "onclick" attributes, so the button's click handler is wired up here
// instead of via onclick="runSearch()" in the HTML.
document.getElementById('searchButton').addEventListener('click', runSearch);

function getSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;
    const s1 = str1.toLowerCase().replace(/[^a-z0-9 ]/g, '');
    const s2 = str2.toLowerCase().replace(/[^a-z0-9 ]/g, '');
    const words1 = s1.split(' ');
    const words2 = s2.split(' ');
    const intersection = words1.filter(word => words2.includes(word));
    return (2.0 * intersection.length) / (words1.length + words2.length);
}

function formatImageUrl(url) {
    if (!url) return 'https://placehold.co/50x50?text=No+Image';
    if (url.startsWith('http')) return url;
    return `https://www.woolworths.com.au${url}`;
}

// Fallback unit-price calculator: parses a quantity + unit (e.g. "2L", "500g")
// out of the product name/size and normalises to $/100g or $/100mL so shoppers
// can compare value even when a retailer doesn't supply its own unit price.
function computeUnitPrice(product) {
    if (!product || product.price == null) return null;
    if (product.unitPrice) return product.unitPrice;
    const match = (product.name || '').match(/(\d+(?:\.\d+)?)\s?(kg|g|ml|l)\b/i);
    if (!match) return null;
    const qty = parseFloat(match[1]);
    const unit = match[2].toLowerCase();
    let baseQty, baseLabel;
    if (unit === 'kg') { baseQty = qty * 1000; baseLabel = '100g'; }
    else if (unit === 'g') { baseQty = qty; baseLabel = '100g'; }
    else if (unit === 'l') { baseQty = qty * 1000; baseLabel = '100mL'; }
    else if (unit === 'ml') { baseQty = qty; baseLabel = '100mL'; }
    else return null;
    if (!baseQty) return null;
    const pricePer100 = (product.price / baseQty) * 100;
    if (!isFinite(pricePer100)) return null;
    return `$${pricePer100.toFixed(2)} / ${baseLabel}`;
}

// Classifies a product as sold by weight, volume, or "each" (count/pack),
// based on its name and unit-price text. Used so we only compare/highlight
// "cheapest" across products actually sold in the same kind of unit
// (e.g. don't compare a per-kg item against a per-each item).
function classifyUnitType(product) {
    if (!product) return 'unknown';
    const text = `${product.name || ''} ${product.unitPrice || ''}`.toLowerCase();
    if (/\b\d+(?:\.\d+)?\s?(kg|g)\b/.test(text) || /per\s*100\s*g\b/.test(text) || /\/\s*100\s*g\b/.test(text)) {
        return 'weight';
    }
    if (/\b\d+(?:\.\d+)?\s?(l|ml)\b/.test(text) || /per\s*100\s*ml\b/.test(text) || /\/\s*100\s*ml\b/.test(text)) {
        return 'volume';
    }
    if (/\beach\b/.test(text) || /\bpack of\b/.test(text) || /\b\d+\s?(pk|pack)\b/.test(text) || /per\s*each\b/.test(text)) {
        return 'each';
    }
    return 'unknown';
}

// Parses a unit-price string like "$3.65 / 1L", "$2.38 per 100 g", "$2.50 / 1kg",
// or "$4.00 / each" into a common comparable basis (price per gram/mL/each),
// so differently-sized packs can be compared on genuine value rather than sticker price.
function normalizeUnitPrice(text) {
    if (!text) return null;
    const match = text.match(/\$?(\d+(?:\.\d+)?)\s*(?:\/|per)\s*(\d+(?:\.\d+)?)?\s*(kilograms?|kg|grams?|g|litres?|liters?|l|millilitres?|milliliters?|ml|each|ea)\b/i);
    if (!match) return null;
    const price = parseFloat(match[1]);
    const qty = match[2] ? parseFloat(match[2]) : 1;
    const unit = match[3].toLowerCase();
    if (!qty || !price) return null;

    if (unit.startsWith('k')) return { value: (price / qty / 1000) * 100, basis: 'weight' };
    if (unit === 'g' || unit.startsWith('gram')) return { value: (price / qty) * 100, basis: 'weight' };
    if (unit === 'l' || unit.startsWith('lit')) return { value: (price / qty / 1000) * 100, basis: 'volume' };
    if (unit.startsWith('m')) return { value: (price / qty) * 100, basis: 'volume' };
    if (unit.startsWith('ea')) return { value: price / qty, basis: 'each' };
    return null;
}

// True when running as an installed Chrome extension (popup). Extension pages with
// matching host_permissions are exempt from CORS, so we can call the retail sites
// directly instead of relying on the local Python proxy.
function isExtensionContext() {
    return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
}

async function fetchShop(path, keyword) {
    const response = await fetch(`${path}?q=${encodeURIComponent(keyword)}`);
    const data = await response.json().catch(() => null);
    if (!response.ok || !Array.isArray(data)) {
        const message = (data && data.error) || `${path} error ${response.status}`;
        throw new Error(message);
    }
    return data.map(prod => ({
        ...prod,
        image: formatImageUrl(prod.image)
    }));
}

// ---- Direct calls (used only inside the extension, bypasses CORS via host_permissions) ----

function woolworthsDiscountText(prod, price, wasPrice) {
    if (prod.IsHalfPrice) return '1/2 Price';
    let headerText = (prod.HeaderTag && prod.HeaderTag.Content ? prod.HeaderTag.Content : '')
        .replace(/<[^>]+>/g, '').trim();
    if (['EVERYDAY LOW PRICE', 'LOW PRICE'].includes(headerText.toUpperCase())) headerText = '';
    if (wasPrice && wasPrice > price) {
        if (headerText) return headerText;
        if (prod.SavingsAmount) return `Save $${parseFloat(prod.SavingsAmount).toFixed(2)}`;
        const percentOff = Math.round(((wasPrice - price) / wasPrice) * 100);
        return percentOff >= 50 ? '1/2 Price' : `${percentOff}% Off`;
    }
    return null;
}

async function searchWoolworthsDirect(keyword) {
    // Warm up cookies first (site expects a prior visit).
    await fetch('https://www.woolworths.com.au/', { credentials: 'include' }).catch(() => { });
    const searchTerm = encodeURIComponent(keyword);
    const response = await fetch('https://www.woolworths.com.au/apis/ui/Search/products', {
        method: 'POST',
        credentials: 'include',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/plain, */*',
        },
        body: JSON.stringify({
            SearchTerm: keyword,
            PageNumber: 1,
            PageSize: 24,
            SortType: 'TraderRelevance',
            Filters: [],
            IsSpecial: false,
            Location: `/shop/search/products?searchTerm=${searchTerm}`,
        }),
    });
    if (!response.ok) throw new Error(`Woolworths error ${response.status}`);
    const data = await response.json();
    const products = [];
    (data.Products || []).forEach(group => {
        const items = group.Products || [];
        if (!items.length) return;
        const prod = items[0];
        const price = prod.Price;
        if (price == null) return;
        let wasPrice = prod.WasPrice;
        if (!(wasPrice && wasPrice > price)) wasPrice = null;
        products.push({
            name: prod.Name || group.Name || 'Unknown',
            price: parseFloat(price),
            wasPrice: wasPrice ? parseFloat(wasPrice) : null,
            discountText: woolworthsDiscountText(prod, price, wasPrice),
            image: formatImageUrl(prod.MediumImageFile || prod.SmallImageFile || ''),
            unitPrice: (prod.CupPrice && prod.CupMeasure)
                ? `$${parseFloat(prod.CupPrice).toFixed(2)} / ${prod.CupMeasure}`
                : null,
            shop: 'Woolworths',
        });
    });
    return products;
}

function colesImage(uris) {
    if (!uris || !uris.length) return formatImageUrl(null);
    const uri = typeof uris[0] === 'object' ? uris[0].uri : uris[0];
    if (!uri) return formatImageUrl(null);
    return uri.startsWith('http') ? uri : `https://productimages.coles.com.au/productimages${uri}`;
}

function colesDiscount(pricing, price) {
    let wasPrice = pricing.was || 0;
    wasPrice = (wasPrice && wasPrice > price) ? parseFloat(wasPrice) : null;
    const description = pricing.priceDescription || pricing.offerDescription || pricing.saveStatement;
    if (description) return { wasPrice, discountText: String(description) };
    if (wasPrice) {
        const percentOff = Math.round(((wasPrice - price) / wasPrice) * 100);
        return { wasPrice, discountText: percentOff >= 50 ? '1/2 Price' : `${percentOff}% Off` };
    }
    return { wasPrice: null, discountText: null };
}

async function searchColesDirect(keyword) {
    const searchUrl = `https://www.coles.com.au/search/products?q=${encodeURIComponent(keyword)}`;
    const response = await fetch(searchUrl, { credentials: 'include' });
    if (!response.ok) throw new Error(`Coles error ${response.status}`);
    const html = await response.text();
    const match = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) throw new Error('Coles homepage did not include product data');
    const nextData = JSON.parse(match[1]);
    const searchResults = (nextData.props && nextData.props.pageProps && nextData.props.pageProps.searchResults) || {};
    const results = searchResults.results || [];
    const products = [];
    results.forEach(item => {
        if (item._type !== 'PRODUCT' && !item.pricing) return;
        const pricing = item.pricing || {};
        const price = pricing.now;
        if (price == null) return;
        const name = [item.brand, item.name, item.size].filter(Boolean).join(' ').trim() || 'Unknown';
        const { wasPrice, discountText } = colesDiscount(pricing, parseFloat(price));
        const unit = pricing.unit || {};
        const unitPrice = (unit.price && unit.ofMeasureUnits)
            ? `$${parseFloat(unit.price).toFixed(2)} / ${unit.ofMeasureQuantity || 1}${unit.ofMeasureUnits}`
            : (pricing.comparable || null);
        products.push({
            name,
            price: parseFloat(price),
            wasPrice,
            discountText,
            image: colesImage(item.imageUris),
            unitPrice,
            shop: 'Coles',
        });
    });
    return products;
}

// Tries the preferred fetch method first (direct call in extension context, proxy
// otherwise) and automatically falls back to the other method if the first one
// throws. This makes the app resilient whether it's loaded as the installed
// extension popup or as a plain page served by the local Python proxy.
async function fetchWithFallback(directFn, proxyPath, keyword, shopName) {
    const preferDirect = isExtensionContext();
    const primary = preferDirect
        ? () => directFn(keyword)
        : () => fetchShop(proxyPath, keyword);
    const fallback = preferDirect
        ? () => fetchShop(proxyPath, keyword)
        : () => directFn(keyword);

    try {
        return { products: await primary(), error: null };
    } catch (primaryError) {
        console.warn(`${shopName} primary fetch failed, trying fallback.`, primaryError);
        try {
            return { products: await fallback(), error: null };
        } catch (fallbackError) {
            console.error(`${shopName} live fetch failed (both methods).`, primaryError, fallbackError);
            const message = fallbackError.message || primaryError.message || String(fallbackError);
            return { products: [], error: message };
        }
    }
}

async function fetchWoolworths(keyword) {
    return fetchWithFallback(searchWoolworthsDirect, '/api/woolworths', keyword, 'Woolworths');
}

async function fetchColes(keyword) {
    return fetchWithFallback(searchColesDirect, '/api/coles', keyword, 'Coles');
}

// ---- Aldi ----
// Aldi AU's website (aldi.com.au) runs on Nuxt, not Next.js, so there is no
// __NEXT_DATA__ script to scrape. The site's own frontend fetches results from
// Aldi's public product-search API, so we call that directly instead.

function aldiImage(assets) {
    if (!assets || !assets.length) return formatImageUrl(null);
    const asset = assets[0];
    const assetId = typeof asset === 'string' ? asset : (asset.assetId || asset.id);
    if (!assetId) return formatImageUrl(null);
    return `https://dm.apac.cms.aldi.cx/is/image/aldiprodapac/${assetId}?wid=100`;
}

function parseAldiProducts(items) {
    const products = [];
    (items || []).forEach(item => {
        const priceInfo = item.price || {};
        const priceCents = priceInfo.amountRelevant ?? priceInfo.amount ?? priceInfo.value;
        if (priceCents == null) return;
        // Aldi's API returns amounts in cents (e.g. 399 == $3.99).
        const price = parseFloat(priceCents) / 100;
        const wasRaw = priceInfo.wasPriceAmount ?? priceInfo.previousAmount;
        const wasPrice = (wasRaw && (parseFloat(wasRaw) / 100) > price) ? parseFloat(wasRaw) / 100 : null;
        const sizeLabel = item.sellingSize || item.size || '';
        const name = [item.name || item.title, sizeLabel].filter(Boolean).join(' ').trim() || 'Unknown';
        products.push({
            name,
            price,
            wasPrice,
            discountText: wasPrice ? 'Special Buy' : null,
            image: aldiImage(item.assets),
            unitPrice: priceInfo.comparisonDisplay || null,
            shop: 'Aldi',
        });
    });
    return products;
}

async function searchAldiDirect(keyword) {
    const url = `https://api.aldi.com.au/v3/product-search?currency=AUD&serviceType=walk-in&limit=24&offset=0&sort=relevance&getNotForEveryoneProducts=true&q=${encodeURIComponent(keyword)}`;
    const response = await fetch(url, {
        credentials: 'include',
        headers: {
            'Accept': 'application/json',
            'Referer': `https://www.aldi.com.au/results?q=${encodeURIComponent(keyword)}`,
        },
    });
    if (!response.ok) throw new Error(`Aldi error ${response.status}`);
    const data = await response.json();
    return parseAldiProducts(data.data || data.results || []);
}

async function fetchAldi(keyword) {
    return fetchWithFallback(searchAldiDirect, '/api/aldi', keyword, 'Aldi');
}

// Renders a full shop cell: image, product name, discounted price (most prominent,
// original price below it), discount badge, and unit price when available.
// `isCheapest` adds a highlight so the winning retailer stands out visually
// instead of relying on a separate "Cheapest" column.
function formatShopCell(product, shopError, isCheapest) {
    if (!product || product.price == null) {
        if (shopError) {
            return `<div class="shop-cell not-found" title="${shopError.replace(/"/g, '&quot;')}">⚠️ ${shopError}</div>`;
        }
        return '<div class="shop-cell not-found">Not found</div>';
    }
    const image = product.image || 'https://placehold.co/50x50?text=No+Image';
    const hasWasPrice = product.wasPrice != null && product.wasPrice > product.price;
    const unitPrice = computeUnitPrice(product);

    // Unit price is shown first and bold -- shoppers compare value using unit price,
    // not the raw sticker price, so it's the primary figure here.
    let priceHtml = `<div class="price-container">`;
    if (unitPrice) {
        priceHtml += `<span class="unit-price">${unitPrice}</span>`;
    }
    priceHtml += `<span class="current-price">$${product.price.toFixed(2)}</span>`;
    if (hasWasPrice) {
        priceHtml += `<span class="was-price">$${product.wasPrice.toFixed(2)}</span>`;
    }
    if (product.discountText) {
        priceHtml += `<span class="discount-badge">${product.discountText}</span>`;
    }
    priceHtml += `</div>`;

    const cellClass = isCheapest ? 'shop-cell cheapest' : 'shop-cell';

    return `
        <div class="${cellClass}">
            <img src="${image}" class="product-img" alt="${product.name}">
            <div class="shop-cell-info">
                <div class="shop-cell-name">${product.name}</div>
                ${priceHtml}
            </div>
        </div>
    `;
}

function findBestMatch(baseProduct, candidates, used) {
    const baseType = classifyUnitType(baseProduct);
    let bestMatch = null;
    let highestScore = 0;
    candidates.forEach((candidate, index) => {
        if (used.has(index)) return;
        const candidateType = classifyUnitType(candidate);
        // Skip comparing across incompatible unit types (e.g. weight vs each).
        // If either side is 'unknown', allow it through since we can't tell.
        if (baseType !== 'unknown' && candidateType !== 'unknown' && baseType !== candidateType) {
            return;
        }
        const score = getSimilarity(baseProduct.name, candidate.name);
        if (score > highestScore && score > 0.45) {
            highestScore = score;
            bestMatch = { product: candidate, index };
        }
    });
    return bestMatch;
}

// Returns the set of shop names tied for cheapest, restricted to entries that
// share the same unit type as the majority/base product -- so a per-kg item
// is never compared against a per-each item, only genuinely equivalent units.
// Comparison uses normalised unit price (e.g. $/100g), not the raw sticker price,
// so a bigger pack that's actually worse value doesn't win just for costing less.
function cheapestShops(entries) {
    const withType = entries
        .filter(e => e.product && e.product.price != null)
        .map(e => {
            const unitInfo = normalizeUnitPrice(computeUnitPrice(e.product));
            return {
                ...e,
                unitType: unitInfo ? unitInfo.basis : classifyUnitType(e.product),
                comparablePrice: unitInfo ? unitInfo.value : e.product.price,
            };
        });
    if (withType.length === 0) return new Set();

    const knownTypes = withType.map(e => e.unitType).filter(t => t !== 'unknown');
    let comparable = withType;
    if (knownTypes.length > 0) {
        // Use the most common known unit type as the basis for comparison.
        const counts = {};
        knownTypes.forEach(t => { counts[t] = (counts[t] || 0) + 1; });
        const majorityType = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
        comparable = withType.filter(e => e.unitType === 'unknown' || e.unitType === majorityType);
    }

    if (comparable.length === 0) return new Set();
    const minPrice = Math.min(...comparable.map(o => o.comparablePrice));
    return new Set(comparable.filter(o => o.comparablePrice === minPrice).map(o => o.shop));
}

async function runSearch() {
    const keyword = document.getElementById('searchInput').value;
    if (!keyword) return alert('Please enter a product.');

    const loading = document.getElementById('loading');
    const resultsDiv = document.getElementById('results');

    loading.style.display = 'block';
    resultsDiv.innerHTML = '';

    try {
        const wwEnabled = RETAILER_CONFIG.woolworths.enabled;
        const colesEnabled = RETAILER_CONFIG.coles.enabled;
        const aldiEnabled = RETAILER_CONFIG.aldi.enabled;

        const [ww, coles, aldi] = await Promise.all([
            wwEnabled ? fetchWoolworths(keyword) : Promise.resolve({ products: [], error: null }),
            colesEnabled ? fetchColes(keyword) : Promise.resolve({ products: [], error: null }),
            aldiEnabled ? fetchAldi(keyword) : Promise.resolve({ products: [], error: null })
        ]);
        const wwProducts = ww.products;
        const colesProducts = coles.products;
        const aldiProducts = aldi.products;

        const matches = [];
        const usedColes = new Set();
        const usedAldi = new Set();

        wwProducts.forEach(wwProd => {
            const colesMatch = colesEnabled ? findBestMatch(wwProd, colesProducts, usedColes) : null;
            if (colesMatch) usedColes.add(colesMatch.index);
            const aldiMatch = aldiEnabled ? findBestMatch(wwProd, aldiProducts, usedAldi) : null;
            if (aldiMatch) usedAldi.add(aldiMatch.index);

            const colesProd = colesMatch ? colesMatch.product : { price: null, wasPrice: null, discountText: null };
            const aldiProd = aldiMatch ? aldiMatch.product : { price: null, wasPrice: null, discountText: null };

            matches.push({
                productName: wwProd.name,
                wwProd: wwProd,
                colesProd: colesProd,
                aldiProd: aldiProd
            });
        });

        if (matches.length === 0) {
            let hint;
            const activeErrors = [
                wwEnabled ? ww.error : null,
                colesEnabled ? coles.error : null,
                aldiEnabled ? aldi.error : null,
            ].filter(Boolean);
            if (activeErrors.length > 0) {
                hint = activeErrors.map(r => `⚠️ ${r}`).join('<br>');
            } else {
                hint = isExtensionContext()
                    ? 'No live products found for that search term.'
                    : 'No live products found. Start the local proxy with <code>python3 server.py</code> then search again.';
            }
            resultsDiv.innerHTML = `<p style="font-size:13px; color:#666;">${hint}</p>`;
        } else {
            let tableHtml = `
            <table class="product-table">
                <thead>
                    <tr>
                        ${wwEnabled ? `<th>${RETAILER_CONFIG.woolworths.label}</th>` : ''}
                        ${colesEnabled ? `<th>${RETAILER_CONFIG.coles.label}</th>` : ''}
                        ${aldiEnabled ? `<th>${RETAILER_CONFIG.aldi.label}</th>` : ''}
                    </tr>
                </thead>
                <tbody>
        `;

            matches.forEach(match => {
                const winners = cheapestShops([
                    { shop: 'Woolworths', product: match.wwProd },
                    { shop: 'Coles', product: match.colesProd },
                    { shop: 'Aldi', product: match.aldiProd },
                ]);

                tableHtml += `
                <tr>
                    ${wwEnabled ? `<td>${formatShopCell(match.wwProd, ww.error, winners.has('Woolworths'))}</td>` : ''}
                    ${colesEnabled ? `<td>${formatShopCell(match.colesProd, coles.error, winners.has('Coles'))}</td>` : ''}
                    ${aldiEnabled ? `<td>${formatShopCell(match.aldiProd, aldi.error, winners.has('Aldi'))}</td>` : ''}
                </tr>
            `;
            });

            tableHtml += '</tbody></table>';
            resultsDiv.innerHTML = tableHtml;
        }
    } catch (err) {
        // Guarantees the loading indicator never gets stuck on an unexpected error.
        console.error('Search failed unexpectedly.', err);
        resultsDiv.innerHTML = `<p style="font-size:13px; color:#c00;">⚠️ Search failed: ${err.message || err}</p>`;
    } finally {
        loading.style.display = 'none';
    }
}
