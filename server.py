#!/usr/bin/env python3
"""Local server that serves compare.html and proxies supermarket APIs (avoids browser CORS)."""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

try:
    from curl_cffi import requests as curl_requests  # type: ignore
except ImportError:  # pragma: no cover - optional dependency
    curl_requests = None

ROOT = Path(__file__).resolve().parent
PORT = 8765

COLES_BUILD_ID: str | None = None

# curl_cffi sessions impersonate a real Chrome TLS/JA3 fingerprint, which is what
# actually lets requests through Coles (Imperva) and Aldi (Akamai) bot protection.
# Plain urllib can never pass this, no matter what headers are sent, because the
# block happens at the TLS handshake level before any HTTP headers are even read.
#
# Note: newer impersonation profiles (chrome124, chrome123, plain "chrome") have
# been fingerprinted and blocked by Coles specifically -- likely because their
# TLS/HTTP2 signature has become well-known as "this is curl_cffi, not a real
# browser". Slightly older profiles (chrome120/chrome110) currently still pass.
# If this stops working again in the future, try swapping to another profile
# from curl_cffi's supported list (or check for a newer curl_cffi release that
# adds a fresh, not-yet-fingerprinted impersonation target).
CURL_IMPERSONATE = "chrome120"
WW_CURL_SESSION = curl_requests.Session(impersonate=CURL_IMPERSONATE) if curl_requests else None
COLES_CURL_SESSION = curl_requests.Session(impersonate=CURL_IMPERSONATE) if curl_requests else None
ALDI_CURL_SESSION = curl_requests.Session(impersonate=CURL_IMPERSONATE) if curl_requests else None


def curl_request(
    session,
    url: str,
    *,
    method: str = "GET",
    data: bytes | None = None,
    headers: dict | None = None,
) -> str:
    if session is None:
        raise RuntimeError(
            "curl_cffi is not installed. Run: pip3 install curl_cffi "
            "(needed to bypass this retailer's bot protection)."
        )
    # Important: do NOT merge in the full urllib-oriented BROWSER_HEADERS here.
    # curl_cffi's impersonation already sends a real, internally consistent
    # Chrome header set matching its TLS/JA3 fingerprint. Overriding those with
    # our own header set (different order/values) makes the request look
    # inconsistent to Imperva/Akamai and gets it blocked again. Only pass the
    # few extra headers actually needed (Referer, Accept, etc).
    response = session.request(method, url, data=data, headers=headers or {}, timeout=25)
    response.raise_for_status()
    return response.text


def search_woolworths(keyword: str) -> list[dict]:
    # Woolworths also blocks plain urllib at the TLS fingerprint level (raises
    # "EOF occurred in violation of protocol"), so use curl_cffi's Chrome
    # impersonation here too, same as Coles and Aldi.
    curl_request(WW_CURL_SESSION, "https://www.woolworths.com.au/")
    payload = json.dumps(
        {
            "SearchTerm": keyword,
            "PageNumber": 1,
            "PageSize": 24,
            "SortType": "TraderRelevance",
            "Filters": [],
            "IsSpecial": False,
            "Location": f"/shop/search/products?searchTerm={urllib.parse.quote(keyword)}",
        }
    ).encode()
    raw = curl_request(
        WW_CURL_SESSION,
        "https://www.woolworths.com.au/apis/ui/Search/products",
        method="POST",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/plain, */*",
            "Origin": "https://www.woolworths.com.au",
            "Referer": f"https://www.woolworths.com.au/shop/search/products?searchTerm={urllib.parse.quote(keyword)}",
        },
    )
    data = json.loads(raw)
    products = []
    for group in data.get("Products") or []:
        items = group.get("Products") or []
        if not items:
            continue
        prod = items[0]
        price = prod.get("Price")
        if price is None:
            continue
        was_price = prod.get("WasPrice")
        if not (was_price and was_price > price):
            was_price = None
        discount_text = _woolworths_discount_text(prod, price, was_price)

        image = prod.get("MediumImageFile") or prod.get("SmallImageFile") or ""
        if image and not str(image).startswith("http"):
            image = f"https://www.woolworths.com.au{image}"

        cup_price = prod.get("CupPrice")
        cup_measure = prod.get("CupMeasure")
        unit_price = (
            f"${float(cup_price):.2f} / {cup_measure}"
            if cup_price and cup_measure
            else None
        )

        products.append(
            {
                "name": prod.get("Name") or group.get("Name") or "Unknown",
                "price": float(price),
                "wasPrice": float(was_price) if was_price and was_price > price else None,
                "discountText": discount_text,
                "image": image or None,
                "unitPrice": unit_price,
                "shop": "Woolworths",
            }
        )
    return products


def _coles_image(uris) -> str | None:
    if not uris:
        return None
    uri = uris[0].get("uri") if isinstance(uris[0], dict) else uris[0]
    if not uri:
        return None
    if str(uri).startswith("http"):
        return uri
    return f"https://productimages.coles.com.au/productimages{uri}"


def _strip_html(value: str) -> str:
    return re.sub(r"<[^>]+>", "", value or "").strip()


def _woolworths_discount_text(prod: dict, price: float, was_price: float | None) -> str | None:
    if prod.get("IsHalfPrice"):
        return "1/2 Price"
    header = prod.get("HeaderTag") or {}
    header_text = _strip_html(header.get("Content") or "")
    if header_text.upper() in {"EVERYDAY LOW PRICE", "LOW PRICE"}:
        header_text = ""
    if was_price and was_price > price:
        if header_text:
            return header_text
        savings = prod.get("SavingsAmount")
        if savings:
            return f"Save ${float(savings):.2f}"
        percent_off = round(((was_price - price) / was_price) * 100)
        return "1/2 Price" if percent_off >= 50 else f"{percent_off}% Off"
    return None


def _coles_discount(pricing: dict, price: float) -> tuple[float | None, str | None]:
    was_price = pricing.get("was") or 0
    was_price = float(was_price) if was_price and was_price > price else None
    description = (
        pricing.get("priceDescription")
        or pricing.get("offerDescription")
        or pricing.get("saveStatement")
    )
    if description:
        return was_price, str(description)
    if was_price:
        percent_off = round(((was_price - price) / was_price) * 100)
        return was_price, "1/2 Price" if percent_off >= 50 else f"{percent_off}% Off"
    return None, None


def _coles_build_id() -> str:
    global COLES_BUILD_ID
    if COLES_BUILD_ID:
        return COLES_BUILD_ID
    html = curl_request(COLES_CURL_SESSION, "https://www.coles.com.au/", headers={"Referer": "https://www.coles.com.au/"})
    match = re.search(r'"buildId":"([^"]+)"', html)
    if not match:
        raise RuntimeError("Coles homepage did not include product data")
    COLES_BUILD_ID = match.group(1)
    return COLES_BUILD_ID


def _raise_if_coles_blocked(html: str) -> None:
    if "Pardon Our Interruption" in html or "_Incapsula_Resource" in html:
        raise RuntimeError(
            "Coles is blocking automated requests (bot protection). "
            "This retailer currently only works from the browser extension "
            "(after you've visited coles.com.au normally in this browser)."
        )


def _coles_search_payload(keyword: str) -> dict:
    """Mirrors how search_woolworths works: call a dedicated JSON data endpoint
    directly (XHR-style, like Woolworths' /apis/ui/Search/products) instead of
    loading the full HTML search page first. Requests go through curl_cffi with
    a real Chrome TLS fingerprint, which is what actually lets them past Coles'
    Imperva bot protection (plain urllib cannot, regardless of headers used).
    """
    global COLES_BUILD_ID
    quoted = urllib.parse.quote(keyword)
    search_url = f"https://www.coles.com.au/search/products?q={quoted}"

    if COLES_BUILD_ID:
        try:
            raw = curl_request(
                COLES_CURL_SESSION,
                f"https://www.coles.com.au/_next/data/{COLES_BUILD_ID}/search/products.json?q={quoted}",
                headers={
                    "Accept": "application/json",
                    "Referer": search_url,
                    "x-nextjs-data": "1",
                    "Sec-Fetch-Dest": "empty",
                    "Sec-Fetch-Mode": "cors",
                    "Sec-Fetch-Site": "same-origin",
                },
            )
            data = json.loads(raw)
            return data.get("pageProps", {}).get("searchResults") or {}
        except Exception:
            # Cached build id may be stale (new deploy); fall through to the full
            # HTML scrape below, which will refresh COLES_BUILD_ID.
            pass

    html = curl_request(COLES_CURL_SESSION, search_url, headers={"Referer": "https://www.coles.com.au/"})
    _raise_if_coles_blocked(html)
    match = re.search(
        r'<script[^>]*id="__NEXT_DATA__"[^>]*>(.*?)</script>',
        html,
        re.S,
    )
    if match:
        data = json.loads(match.group(1))
        COLES_BUILD_ID = data.get("buildId") or COLES_BUILD_ID
        return data.get("props", {}).get("pageProps", {}).get("searchResults") or {}

    build_id = _coles_build_id()
    raw = curl_request(
        COLES_CURL_SESSION,
        f"https://www.coles.com.au/_next/data/{build_id}/search/products.json?q={quoted}",
        headers={
            "Accept": "application/json",
            "Referer": search_url,
            "x-nextjs-data": "1",
        },
    )
    data = json.loads(raw)
    return data.get("pageProps", {}).get("searchResults") or {}


def search_coles(keyword: str) -> list[dict]:
    global COLES_CURL_SESSION, COLES_BUILD_ID
    try:
        payload = _coles_search_payload(keyword)
    except RuntimeError as exc:
        if "bot protection" not in str(exc) or not curl_requests:
            raise
        # A fresh session (new cookie jar / TLS session ticket) occasionally
        # gets past Incapsula even when the previous one was flagged. Retry
        # once before giving up.
        COLES_CURL_SESSION = curl_requests.Session(impersonate=CURL_IMPERSONATE)
        COLES_BUILD_ID = None
        payload = _coles_search_payload(keyword)
    results = payload.get("results") or []
    products = []
    for item in results:
        if item.get("_type") != "PRODUCT" and not item.get("pricing"):
            continue
        pricing = item.get("pricing") or {}
        price = pricing.get("now")
        if price is None:
            continue
        name_parts = [item.get("brand"), item.get("name"), item.get("size")]
        name = " ".join(part for part in name_parts if part).strip() or "Unknown"
        was_price, discount_text = _coles_discount(pricing, float(price))
        unit = pricing.get("unit") or {}
        unit_price = None
        if unit.get("price") and unit.get("ofMeasureUnits"):
            unit_price = (
                f"${float(unit['price']):.2f} / "
                f"{unit.get('ofMeasureQuantity', 1)}{unit['ofMeasureUnits']}"
            )
        elif pricing.get("comparable"):
            unit_price = str(pricing["comparable"])

        products.append(
            {
                "name": name,
                "price": float(price),
                "wasPrice": was_price,
                "discountText": discount_text,
                "image": _coles_image(item.get("imageUris")),
                "unitPrice": unit_price,
                "shop": "Coles",
            }
        )
    return products


def _aldi_image(assets) -> str | None:
    if not assets:
        return None
    asset = assets[0]
    if not isinstance(asset, dict):
        return None
    # Aldi's API now returns a Scene7 image URL template with "{width}" and
    # "{slug}" placeholders instead of a bare asset id.
    url = asset.get("url")
    if url:
        return url.replace("{width}", "300").replace("{slug}", "")
    asset_id = asset.get("assetId") or asset.get("id")
    if not asset_id:
        return None
    return f"https://dm.apac.cms.aldi.cx/is/image/aldiprodapac/{asset_id}?wid=100"


def search_aldi(keyword: str) -> list[dict]:
    """Calls Aldi AU's public product-search API directly via curl_cffi (Chrome TLS
    impersonation), which is needed to get past Aldi's Akamai bot protection.

    Note: Aldi's site (aldi.com.au) runs on Nuxt, not Next.js, so there is no
    __NEXT_DATA__ payload to scrape from the HTML. Their frontend calls this
    same API endpoint directly.
    """
    quoted = urllib.parse.quote(keyword)
    url = (
        "https://api.aldi.com.au/v3/product-search"
        f"?currency=AUD&serviceType=walk-in&limit=24&offset=0&sort=relevance"
        f"&getNotForEveryoneProducts=true&q={quoted}"
    )
    try:
        raw = curl_request(
            ALDI_CURL_SESSION,
            url,
            headers={
                "Accept": "application/json",
                "Referer": f"https://www.aldi.com.au/results?q={quoted}",
            },
        )
    except Exception as exc:
        raise RuntimeError(
            "Aldi is blocking automated requests (bot protection). "
            "This retailer currently only works from the browser extension "
            "(after you've visited aldi.com.au normally in this browser)."
        ) from exc
    data = json.loads(raw)
    items = data.get("data") or data.get("results") or []
    products = []
    for item in items:
        price_info = item.get("price") or {}
        price_cents = price_info.get("amountRelevant", price_info.get("amount"))
        if price_cents is None:
            continue
        # Aldi's API returns amounts in cents (e.g. 399 == $3.99).
        price = float(price_cents) / 100
        was_raw = price_info.get("wasPriceAmount") or price_info.get("previousAmount")
        was_price = None
        if was_raw and (float(was_raw) / 100) > price:
            was_price = float(was_raw) / 100
        size_label = item.get("sellingSize") or item.get("size") or ""
        name = " ".join(part for part in [item.get("name") or item.get("title"), size_label] if part).strip() or "Unknown"

        products.append(
            {
                "name": name,
                "price": price,
                "wasPrice": was_price,
                "discountText": "Special Buy" if was_price else None,
                "image": _aldi_image(item.get("assets")),
                "unitPrice": price_info.get("comparisonDisplay"),
                "shop": "Aldi",
            }
        )
    return products


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        print(f"[{self.log_date_time_string()}] {format % args}")

    def _send_json(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _query(self):
        parsed = urllib.parse.urlparse(self.path)
        return parsed.path, urllib.parse.parse_qs(parsed.query)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        path, query = self._query()
        if path in ("/", "/compare.html"):
            file_path = ROOT / "compare.html"
            body = file_path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if path == "/styles.css":
            file_path = ROOT / "styles.css"
            body = file_path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/css; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if path == "/config.js":
            file_path = ROOT / "config.js"
            body = file_path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if path == "/app.js":
            file_path = ROOT / "app.js"
            body = file_path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if path == "/api/woolworths":
            keyword = (query.get("q") or [""])[0].strip()
            if not keyword:
                self._send_json({"error": "Missing q"}, 400)
                return
            try:
                self._send_json(search_woolworths(keyword))
            except Exception as exc:
                self._send_json({"error": str(exc)}, 502)
            return

        if path == "/api/coles":
            keyword = (query.get("q") or [""])[0].strip()
            if not keyword:
                self._send_json({"error": "Missing q"}, 400)
                return
            try:
                self._send_json(search_coles(keyword))
            except Exception as exc:
                self._send_json({"error": str(exc)}, 502)
            return

        if path == "/api/aldi":
            keyword = (query.get("q") or [""])[0].strip()
            if not keyword:
                self._send_json({"error": "Missing q"}, 400)
                return
            try:
                self._send_json(search_aldi(keyword))
            except Exception as exc:
                self._send_json({"error": str(exc)}, 502)
            return

        self.send_error(404)


def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Open http://127.0.0.1:{PORT}/compare.html", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
