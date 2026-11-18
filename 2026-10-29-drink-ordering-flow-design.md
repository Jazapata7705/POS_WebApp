# Drink Ordering Flow Design

## Context

The Express/EJS menu reads current products from `menuitem`. The current page shows all categories as filters and adds a product directly to an in-memory browser cart. The navigation already links to `/checkout`, but the app has no checkout route or view. The menu database has 22 drinks in four categories and contains no product image or customization fields.

## Goals

- Start with a vertical list of categories, each with an image. Selecting a category opens that category's product menu, with a way back to categories.
- Show a distinct, locally bundled drink illustration for each current menu item.
- Open an organized customization dialog when a user selects a drink.
- Show a review page with every configured drink, its customizations, and correct item and order prices.

## Chosen Approach

Keep the existing Express/EJS application and add a dedicated `/checkout` route and view. Keep category selection, item selection, and customization on the menu page. Store configured cart lines in `sessionStorage` so the cart survives navigation to checkout and refreshes during the browser tab's lifetime. No database schema change or server-side order persistence is needed for this review flow.

The alternatives were a server-session-backed cart, which adds server state and middleware, and a single-page checkout state, which would not provide the requested separate checkout page. The chosen approach fits the current server-rendered app and keeps cart data available when switching views.

## Menu and Customization Behavior

The initial screen presents category rows with category artwork. Selecting a row displays the existing database-backed products in that category. Each product card shows its own illustration, name, description, and base price. Selecting a card opens a dialog with:

- Sugar level choices at no additional cost.
- Ice level choices at no additional cost.
- Optional boba, grass jelly, and pudding add-ons at $0.50 each.
- Optional cheese foam at $1.00.

The available options and prices are kept in one client-side configuration so they can be changed without changing the menu database. Prices are stored and calculated in integer cents.

## Cart and Checkout

Adding a configured drink stores its database item ID, display fields, base price, selected free options, and selected paid add-ons. Lines with identical drink and customization selections may share a quantity; different configurations remain separate lines.

The checkout view lists each line's drink name and quantity, the complete customization list, base price, add-on total, and configured line total. It also displays the order total as the sum of line totals. The cart can be returned to from the menu without losing its selections.

## Images and Accessibility

Provide local SVG illustrations with flavor-matched colors and details for the 22 current drinks; use representative local illustrations for the four category rows. This avoids depending on remote image hosts. Give each image meaningful alternative text. Use semantic buttons and a keyboard-operable customization dialog with a visible close control.

## Scope and Files

The implementation will update `index.js`, `views/index.ejs`, `public/js/client.js`, and `public/css/style.css`; add `views/checkout.ejs`; and add local illustration assets under `public/images/`. It will not change the database schema or add payment processing.

## Review After Implementation

Walk a drink from category selection through customization to checkout. Confirm that free choices add no cost, paid add-ons change the line and order totals by their configured amounts, different configurations stay on separate lines, and cart selections survive navigation and refresh.
