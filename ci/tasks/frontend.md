# Phase B — Frontend: Northwind Outfitters Next.js storefront

You are building the **presentation tier** of a production-grade outdoor-gear store. The root of your workspace already contains a working `backend/` from Phase A. Create `frontend/` (Next.js App Router, React, strict TypeScript) and update the root `README.md` with the frontend run/build instructions. Do not modify backend behaviour or its contract.

## Stack and wiring

- Next.js (App Router) + React + TypeScript strict. Plain CSS (or Tailwind if you add and configure it). Declare every dependency in `package.json`; commit `package-lock.json`.
- Same-origin API calls only. In `next.config.ts`, rewrite `/api/:path*` to `${process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:8080'}/api/:path*`. Never hardcode a port in client code and never call the backend origin directly from the browser.
- The backend sets an httpOnly `nw_token` cookie on login/register. Use `fetch('/api/...')` with same-origin credentials; do not read or store the JWT in JavaScript.
- One typed API module (`lib/api.ts`) producing `ApiError` with `status` and `fieldErrors`; one `lib/types.ts`; one `lib/format.ts` for money/date. No `any`, no `@ts-ignore`, no inline fetch in components.
- Provide a deterministic image fallback (gradient + product initials) when `imageUrl` is null or fails to load. Do not depend on remote images for the UI to look complete.
- Design tokens in `app/globals.css`: one accent, neutral surfaces, 8px spacing scale, readable type, visible focus rings, rounded cards, subtle borders. Dark mode is optional; light must be polished.

## Pages and behaviour

- `/` — hero with one primary CTA, category tiles (from `/api/categories`), 4-8 featured products, trust/benefit strip, footer with links.
- `/products` — full catalog. Search (`q`), category filter, min/max price, in-stock toggle, sort select (`featured|priceAsc|priceDesc|nameAsc|newest`), pagination. All filter state is reflected in the URL query and survives reload/back. Result count, skeleton while loading, empty state with a reset action, error banner with retry.
  - **Data-flow rule:** derive the query values from `useSearchParams()` and put only primitives (`q`, `category`, `minPrice`, `maxPrice`, `inStock`, `sort`, `page`) in the fetch `useEffect` dependency array. Never depend on a newly-created object, array or `URLSearchParams` (for example `[filters]` or `[params]`): that recreates the dependency every render, causes an infinite fetch/re-render loop, and detaches product cards while the verifier clicks them. Memoize derived values if you need an object, or depend on the primitive fields.
  - **Search behaviour:** the `filter-search` input submits on Enter and through the form's Apply button, updates the URL `q`, and keeps the typed value until the filtered result arrives. Product cards use stable `key={product.id}` values.
  - **Authenticated checkout:** the checkout form posts through the same-origin `/api` rewrite with `credentials: 'same-origin'` so the httpOnly `nw_token` cookie is sent; after a signed-in customer checks out, `GET /api/orders` must include that order.
- `/products/[id]` — gallery/fallback, name, price + compare-at price, stock badge, rating summary, quantity stepper, add-to-cart, description, reviews list and a review form for signed-in customers. Breadcrumb. Unknown product → the app's 404 page.
- `/cart` — line items with quantity +/- and remove, subtotal, shipping estimate, checkout CTA, empty state. Cart badge in the header reflects `itemCount`.
- `/checkout` — email, shipping address fields, payment method (`CARD` or `COD`), optional coupon, order summary. Inline field errors from the API, disabled submit while posting, then redirect to `/orders/<orderNumber>?email=<email>` where `<email>` is the value submitted in the checkout form, URL-encoded (the checkout response carries no email field). A guest order is only readable with the matching email, so dropping it from the redirect makes the confirmation page render "Order not found". Successful checkout clears the cart badge.
- `/orders/[orderNumber]` — confirmation with order number (in `order-number`), status, items, totals and shipping address. Read the `email` query parameter and pass it to `GET /api/orders/{orderNumber}?email=...` so a guest sees the order they just placed. Also a guest lookup form (order number + email) that navigates to the order.
- `/account/login`, `/account/register` — email/password forms with validation; on success return to the previous page or `/account/orders`. `/account/orders` lists the signed-in customer's orders; signed-out users are redirected to login.
- `/admin/login` — admin credentials form. On success go to `/admin`; non-admin users get a clear 403 message.
- `/admin` — KPI cards (revenue, orders, products, low stock, customers) and recent orders. Client-side guard: call `/api/auth/me`; if 401/403 redirect to `/admin/login`.
- `/admin/products` — table with search + pagination, create/edit dialog (name, sku, slug, description, price, compareAtPrice, stock, category, imageUrl, active), soft delete. Validate and surface field errors.
- `/admin/orders` — table with status filter; status transition control that only offers valid next states (PLACED→PACKED→SHIPPED→DELIVERED, cancel from PLACED/PACKED).
- `/admin/categories` — list + create/edit/delete (409 shown clearly).
- `/admin/coupons` — list + create/delete (code, type, value, min subtotal, active).
- `app/not-found.tsx` — branded 404 with a link home. `app/error.tsx` — friendly error boundary.
- Header: logo, nav (Shop, Categories anchor, Orders/Account, Admin when role is ADMIN), cart badge. Footer: shop/account/help columns. Skip link to main content.

## Accessibility and responsiveness

- Semantic landmarks (`header`, `nav`, `main`, `footer`), one `h1` per page, labelled inputs, `aria-live` for cart/order totals and toasts.
- Keyboard: every control reachable, visible focus ring, dialogs trap focus and close on Escape, quantity steppers have accessible names.
- Responsive at 360px, 768px and 1440px with no horizontal scroll. Product grid 1/2/3/4 columns.

## Required `data-testid` hooks (the verifier depends on them)

`product-card`, `product-name`, `product-price`, `add-to-cart`, `cart-count`, `cart-line`, `cart-subtotal`, `checkout-button`, `checkout-email`, `checkout-line1`, `checkout-city`, `checkout-postal`, `checkout-country`, `checkout-place-order`, `order-number`, `order-total`, `login-email`, `login-password`, `login-submit`, `admin-kpi-revenue`, `admin-product-new`, `admin-product-name`, `admin-product-price`, `admin-product-stock`, `admin-product-save`, `admin-order-row`, `admin-order-status`, `filter-search`, `filter-category`, `sort-select`, `page-next`.

Both `/account/login` and `/admin/login` must expose the standard `login-email`, `login-password` and `login-submit` hooks. The admin page may add `admin-login-submit`, but the verifier looks for the standard three on either login page.

Use stable roles/labels as well. Do not rename these hooks.

## README (root) update

Add frontend prerequisites, `npm install`, `npm run dev` (with `API_PROXY_TARGET`), `npm run build` + `npm start`, the page map, the testids contract, and a note that the backend must be running.

## Definition of done

1. `npm install --no-audit --no-fund` exits 0 in `frontend/`.
2. `npm run build` exits 0 with strict TypeScript and no type errors.
3. The production build serves every page listed above; `/api/*` is proxied to the backend.
4. No long-running servers, no scratch files, no remote-image dependency.
5. Final report: pages, components, build result, gaps.
