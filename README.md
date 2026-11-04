# called-to-create-platform
An online creative edtech platform.

## Paystack checkout

The course and digital-asset cart drawers open Paystack Inline checkout in a popup through the `paystack-checkout` Supabase Edge Function. The function calculates prices from Supabase, verifies completed transactions with Paystack, and records successful orders. Course orders also create the corresponding enrollment. Never put the Paystack secret key in browser code.

Before deploying:

1. Apply all pending migrations to the Supabase project. This includes the payment-order schema and the private shop asset delivery setup.
   From the repository root, this can be done with:

   ```sh
   supabase link --project-ref ecbftpfbbfvcxreszsfo
   supabase db push --remote
   ```

   Alternatively, run each pending migration in the Supabase SQL Editor, in timestamp order.
2. Set the Paystack secret key and every permitted local/production site origin:

   ```sh
   supabase secrets set PAYSTACK_SECRET_KEY=sk_test_your_key ALLOWED_ORIGINS=http://localhost:5502,http://127.0.0.1:5502,https://your-site.example
   ```

3. Deploy the function:

   ```sh
   supabase functions deploy paystack-checkout
   ```

4. In the Paystack dashboard, configure the webhook URL as `https://ecbftpfbbfvcxreszsfo.supabase.co/functions/v1/paystack-checkout`.

## Shop asset delivery

The shop delivery migration adds `products.storage_path` and creates the private `shop-deliverables` bucket. For each shop item:

1. In Supabase Dashboard, open **Table Editor** → `products` and create the product row. Set its title and KES price; add a description, category, and image URL as needed by the shop card. Keep any generated ID and timestamp values.
2. Open **Storage** → `shop-deliverables` and upload the deliverable file. Note the object path shown in the bucket; for example, `luts/film-look.zip`.
3. Save that object path to `storage_path` on the product row. For example:

```sql
update public.products
set storage_path = 'luts/film-look.zip'
where id = 'PRODUCT_ID';
```

Replace both example values with the real object path and product ID. Repeat for every downloadable shop product. The item appears in `shop.html`; after a verified purchase it is marked as purchased and the customer can download it from **My Library**. Downloads are available only after the server confirms a paid order; the function creates a short-lived signed URL. Course enrollments and their existing course assets remain separate and continue to appear in the library.

Use the Paystack test secret key while testing, then replace it with the live secret key for production. The origins must include the exact origin (scheme, hostname, and port) used to open the site; the same list also restricts Paystack's return URL. The function verifies the Paystack webhook signature and checks transactions directly with Paystack before recording payment. Successful orders are stored in `payment_orders`.
