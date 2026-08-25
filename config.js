// Per-retailer feature toggles for the Supermarket Price Matcher.
// Flip a retailer to `false` to hide it from the results table and skip
// fetching it entirely (useful if a retailer's bot protection is temporarily
// blocking requests). Loaded before compare.html's main script.
const RETAILER_CONFIG = {
    woolworths: { enabled: true, label: 'Woolworths' },
    coles: { enabled: true, label: 'Coles' },
    aldi: { enabled: true, label: 'Aldi' },
};
