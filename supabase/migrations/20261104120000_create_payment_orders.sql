create table if not exists public.payment_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  reference text not null unique,
  item_type text not null check (item_type in ('course', 'product')),
  item_ids jsonb not null check (jsonb_typeof(item_ids) = 'array'),
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency = 'KES'),
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed')),
  paystack_transaction_id bigint,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

alter table public.payment_orders enable row level security;

drop policy if exists "Users can view their own payment orders"
  on public.payment_orders;

create policy "Users can view their own payment orders"
  on public.payment_orders
  for select
  to authenticated
  using (auth.uid() = user_id);

grant select on public.payment_orders to authenticated;

create or replace function public.complete_payment_order(
  p_reference text,
  p_transaction_id bigint
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  payment_order public.payment_orders%rowtype;
  selected_course_id text;
begin
  select *
  into payment_order
  from public.payment_orders
  where reference = p_reference
  for update;

  if not found then
    raise exception 'Payment order not found';
  end if;
  if payment_order.status = 'paid' then
    return payment_order.item_type;
  end if;
  if payment_order.status <> 'pending' then
    raise exception 'Payment order is not pending';
  end if;

  if payment_order.item_type = 'course' then
    for selected_course_id in
      select jsonb_array_elements_text(payment_order.item_ids)
    loop
      perform pg_advisory_xact_lock(
        hashtextextended(payment_order.user_id::text || ':' || selected_course_id, 0)
      );
      insert into public.enrollments (user_id, course_id, payment_gateway)
      select payment_order.user_id, selected_course_id, 'paystack'
      where not exists (
        select 1
        from public.enrollments enrollment
        where enrollment.user_id = payment_order.user_id
          and enrollment.course_id = selected_course_id
      );
    end loop;
  end if;

  update public.payment_orders
  set status = 'paid',
      paid_at = now(),
      paystack_transaction_id = p_transaction_id
  where id = payment_order.id;

  return payment_order.item_type;
end;
$$;

revoke all on function public.complete_payment_order(text, bigint) from public, anon, authenticated;
grant execute on function public.complete_payment_order(text, bigint) to service_role;
