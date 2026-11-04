# Phase A — Backend: Northwind Outfitters three-tier store

You are building the **backend tier** of a production-grade outdoor-gear store. The root of your workspace is the current working directory. Create `backend/`, a Maven project, and a root `README.md`. Do not create or modify `frontend/` in this phase.

## Stack and configuration

- Java 17 language level, Spring Boot 3.5.x parent, Maven (`mvn -q -B`).
- Spring Web, Bean Validation, Spring Data JPA, H2 (file mode), Actuator. Add springdoc-openapi only if you declare it; do not add Lombok or code generators.
- H2 file database at `./data/northwind` (`jdbc:h2:file:./data/northwind;DB_CLOSE_ON_EXIT=FALSE`). Create `./data` before the datasource opens.
- `spring.jpa.hibernate.ddl-auto=update`, `spring.jpa.open-in-view=false`, JSON errors from one `@RestControllerAdvice`.
- Seed is idempotent and guarded by `app.seed=true`.
- Package root `com.northwind.store`; layers: `config`, `domain`, `repo`, `service`, `web`, `web/dto`, `error`, `security`.
- Tests use an in-memory H2 database and never touch the file database.

## Data model (JPA entities)

- `Category`: id, name (unique), slug (unique), description.
- `Product`: id, sku (unique), name, slug (unique), description, price `BigDecimal(12,2)`, compareAtPrice nullable, stock int, active boolean, category FK, imageUrl nullable, ratingAvg `BigDecimal(3,2)`, ratingCount int, createdAt.
- `Customer`: id, email (unique), passwordHash (BCrypt), name, role `CUSTOMER|ADMIN`, createdAt.
- `Cart`: id (UUID string), customerId nullable, createdAt, updatedAt.
- `CartItem`: id, cart FK, product FK, quantity; unique (cart, product).
- `Order`: id, orderNumber (unique), customerId nullable, email, status `PLACED|PACKED|SHIPPED|DELIVERED|CANCELLED`, subtotal, discount, shipping, tax, total (`BigDecimal`), currency `USD`, shipping address fields (line1, line2, city, state, postalCode, country), paymentMethod `CARD|COD`, couponCode nullable, idempotencyKey nullable unique, createdAt, updatedAt.
- `OrderItem`: id, order FK, productId, productName, sku, unitPrice, quantity, lineTotal.
- `Review`: id, product FK, customer FK, rating 1..5, title, body, authorName, createdAt.
- `Coupon`: id, code (unique, uppercase), type `PERCENT|FIXED`, value `BigDecimal`, minSubtotal, active, expiresAt nullable.

## Fixed HTTP contract

Base path `/api`. Request/response JSON. One error envelope:
`{ "error": "message", "fieldErrors": { "field": "message" } }` (`fieldErrors` optional). Status codes: 400 validation, 401 missing/invalid auth, 403 wrong role, 404 missing, 409 duplicate/state/stock.

### Public catalog

- `GET /api/health` → 200 `{"status":"UP"}`.
- `GET /api/categories` → `{"items":[{id,name,slug,description,productCount}]}`.
- `GET /api/products?page=0&size=12&sort=featured&q=&category=&minPrice=&maxPrice=&inStock=`
  - `sort`: `featured|priceAsc|priceDesc|nameAsc|newest`.
  - `category` accepts id, slug or name.
  - response `{"items":[product],"page":0,"size":12,"total":12,"totalPages":1}` where product is `{id,sku,name,slug,price,compareAtPrice,stock,imageUrl,ratingAvg,ratingCount,category:{id,name,slug}}`.
  - invalid page/size/price → 400.
- `GET /api/products/{idOrSlug}` → full product detail including `description` and `category`; unknown → 404.
- `GET /api/products/{id}/reviews` → `{"items":[{id,rating,title,body,authorName,createdAt}],"average":4.5,"count":2}`.

### Auth

- `POST /api/auth/register` `{email,password,name}` → 201 `{token,user:{id,email,name,role}}`; duplicate → 409; password shorter than 8 → 400 field error.
- `POST /api/auth/login` `{email,password}` → 200 same shape; bad credentials → 401.
- `GET /api/auth/me` (Bearer or `nw_token` cookie) → user; missing/invalid → 401.
- JWT HS256, secret from `app.jwt.secret` (dev default is fine), 24 h expiry. Login/register also set an httpOnly `nw_token` cookie; `POST /api/auth/logout` clears it.
- `GET /api/auth/me` returns `role` so the UI can guard `/admin`.

### Cart and checkout

- `POST /api/cart` → 201 `{cartId,items:[],subtotal:0,itemCount:0}`.
- `GET /api/cart/{cartId}` → `{cartId,items:[{id,productId,name,slug,unitPrice,quantity,lineTotal,imageUrl,stock}],subtotal,itemCount}`.
- `POST /api/cart/{cartId}/items` `{productId,quantity}` → 200 cart; quantity < 1 or > stock → 400; unknown product/cart → 404.
- `PATCH /api/cart/{cartId}/items/{itemId}` `{quantity}` → 200 cart; quantity 0 removes the line.
- `DELETE /api/cart/{cartId}/items/{itemId}` → 200 cart.
- `POST /api/checkout` optional `Idempotency-Key` header, body:
  `{cartId,email,shippingAddress:{line1,line2,city,state,postalCode,country},paymentMethod:"CARD"|"COD",couponCode?}`
  → 201 `{orderId,orderNumber,status,subtotal,discount,shipping,tax,total,items:[...]}`.
  - Rules: tax 8.25% of (subtotal - discount); shipping 6.99 unless (subtotal - discount) >= 75 then 0; coupon applied before tax/shipping; empty cart → 400; unknown/expired/ineligible coupon → 400 with field error `couponCode`; insufficient stock → 409.
  - Decrement stock atomically in one transaction. Replaying the same `Idempotency-Key` returns the original order (same `orderNumber`) and never creates a second order.
- `GET /api/orders/{orderNumber}?email=` → order for the matching email (guest lookup); mismatched email → 403; unknown → 404.
- `GET /api/orders` (auth) → `{"items":[order]}` for the signed-in customer.

### Reviews

- `POST /api/products/{id}/reviews` (auth) `{rating,title,body}` → 201 review; rating outside 1..5 → 400; recompute `ratingAvg`/`ratingCount` on the product.
- One review per customer per product is not required.

### Admin (Bearer/cookie with role ADMIN; 401 unauthenticated, 403 non-admin)

- `GET /api/admin/products?page=&size=&q=` → paginated products including inactive.
- `POST /api/admin/products` → 201 product; `PUT /api/admin/products/{id}` → 200; `DELETE` → 204 (soft delete, `active=false`).
- `POST /api/admin/categories` → 201; `PUT /api/admin/categories/{id}` → 200; `DELETE` → 204, or 409 when products reference it.
- `GET /api/admin/orders?status=&page=&size=` → paginated orders.
- `PATCH /api/admin/orders/{id}/status` `{status}` → 200. Allowed transitions: `PLACED→PACKED`, `PACKED→SHIPPED`, `SHIPPED→DELIVERED`, and cancel from `PLACED|PACKED`. Invalid transition → 409. Cancelling restores stock.
- `GET /api/admin/coupons` → `{items:[coupon]}`; `POST /api/admin/coupons` → 201; `DELETE /api/admin/coupons/{id}` → 204.
- `GET /api/admin/kpis` → `{revenue,orders,products,lowStock,customers,recentOrders:[{orderNumber,total,status,createdAt}]}`. `revenue` excludes cancelled orders; `lowStock` counts active products with stock <= 5.

## Seed data (idempotent, `app.seed=true`)

- Admin `admin@northwind.test` / `Admin123!`; customer `alex@example.com` / `Customer123!`.
- 6 categories: Camping, Hiking, Climbing, Fishing, Cycling, Apparel.
- 12 active products with realistic outdoor names, prices between 19.99 and 349.99, stock 0..40 (at least one low-stock and one out-of-stock), `imageUrl = null`.
- 2 coupons: `WELCOME10` (PERCENT 10, min 50), `GEAR20` (FIXED 20, min 100).

## Tests (>= 25)

JUnit 5 + MockMvc. Cover: context load; product pagination/filter/search/sort; product detail 404; categories; register/login/me + 401; admin 403; cart add/update/remove + stock rejection; checkout totals/coupon/idempotency/insufficient stock; order lookup 403/404; review validation + rating aggregate; admin product CRUD; order status transitions + cancel restores stock; KPI shape. Keep tests deterministic.

## README (root)

Prerequisites, backend run/test/package commands, H2 location, seed credentials, endpoint table, configuration properties, and a short architecture note.

## Definition of done

1. `mvn -q -B test` exits 0 with >= 25 tests and no failures.
2. `mvn -q -B -DskipTests package` exits 0 and produces `backend/target/*.jar`.
3. `./data` is created automatically at startup and the jar boots on a fresh database.
4. No long-running servers or scratch files are left behind.
5. Final report: files, endpoints, test count, build result, seed credentials, gaps.
