alter table public.payment_orders
  drop constraint if exists payment_orders_status_check;

alter table public.payment_orders
  add constraint payment_orders_status_check
  check (status in ('pending', 'paid', 'failed', 'refunded'));

create table if not exists public.admin_action_audit (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users (id) on delete set null,
  provider text not null check (provider in ('supabase', 'paystack', 'bunny')),
  action text not null,
  target_id text,
  status text not null default 'pending'
    check (status in ('pending', 'succeeded', 'failed')),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists admin_action_audit_created_at_idx
  on public.admin_action_audit (created_at desc);

alter table public.admin_action_audit enable row level security;
revoke all on public.admin_action_audit from public, anon, authenticated;
grant all on public.admin_action_audit to service_role;
grant usage, select on sequence public.admin_action_audit_id_seq to service_role;

create table if not exists public.admin_payment_refunds (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.payment_orders (id) on delete cascade,
  audit_id bigint not null references public.admin_action_audit (id),
  actor_id uuid references auth.users (id) on delete set null,
  paystack_refund_id text unique,
  amount_minor bigint not null check (amount_minor > 0),
  status text not null default 'pending'
    check (status in ('pending', 'processed', 'failed')),
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists admin_payment_refunds_one_active_order_idx
  on public.admin_payment_refunds (order_id)
  where status in ('pending', 'processed');

alter table public.admin_payment_refunds enable row level security;
revoke all on public.admin_payment_refunds from public, anon, authenticated;
grant all on public.admin_payment_refunds to service_role;
grant usage, select on sequence public.admin_payment_refunds_id_seq to service_role;

create table if not exists public.site_monthly_metrics (
  month_start date not null,
  metric_key text not null
    check (metric_key in (
      'page_view', 'lcp_ms', 'cls', 'inp_ms', 'fcp_ms', 'ttfb_ms',
      'course_download_link', 'shop_download_link', 'supabase_query_ms', 'admin_function_ms'
    )),
  route text not null,
  sample_count bigint not null default 0 check (sample_count >= 0),
  value_sum numeric not null default 0,
  value_max numeric,
  updated_at timestamptz not null default now(),
  primary key (month_start, metric_key, route)
);

alter table public.site_monthly_metrics enable row level security;
revoke all on public.site_monthly_metrics from public, anon, authenticated;
grant all on public.site_monthly_metrics to service_role;

create or replace function public.record_site_monthly_metric(
  p_metric_key text,
  p_route text,
  p_value numeric default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  normalized_route text;
  month_bucket date;
begin
  if p_metric_key is null
    or p_metric_key not in (
      'page_view', 'lcp_ms', 'cls', 'inp_ms', 'fcp_ms', 'ttfb_ms',
      'course_download_link', 'shop_download_link', 'supabase_query_ms', 'admin_function_ms'
    )
    or p_route is null
    or length(p_route) > 160
    or p_route not in (
      '/', '/index.html', '/explore.html', '/how-it-works.html', '/course.html',
      '/library.html', '/privacy.html', '/terms.html', '/search.html',
      '/shop.html', '/support.html', '/admin.html'
    )
    or (p_metric_key in ('page_view', 'course_download_link', 'shop_download_link') and p_value is not null)
    or (p_metric_key not in ('page_view', 'course_download_link', 'shop_download_link')
      and (p_value is null or p_value < 0 or p_value > 600000)) then
    raise exception 'Invalid site metric';
  end if;

  normalized_route := coalesce(nullif(p_route, ''), '/');
  month_bucket := date_trunc('month', now() at time zone 'UTC')::date;

  insert into public.site_monthly_metrics (
    month_start, metric_key, route, sample_count, value_sum, value_max
  )
  values (
    month_bucket,
    p_metric_key,
    normalized_route,
    1,
    coalesce(p_value, 0),
    p_value
  )
  on conflict (month_start, metric_key, route) do update
  set sample_count = site_monthly_metrics.sample_count + 1,
      value_sum = site_monthly_metrics.value_sum + excluded.value_sum,
      value_max = case
        when excluded.value_max is null then site_monthly_metrics.value_max
        when site_monthly_metrics.value_max is null then excluded.value_max
        else greatest(site_monthly_metrics.value_max, excluded.value_max)
      end,
      updated_at = now();

  delete from public.site_monthly_metrics
  where month_start < (month_bucket - interval '11 months')::date;
end;
$$;

revoke all on function public.record_site_monthly_metric(text, text, numeric)
  from public, anon, authenticated;
grant execute on function public.record_site_monthly_metric(text, text, numeric)
  to service_role;

create or replace function public.admin_begin_payment_refund(
  p_actor_id uuid,
  p_order_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  payment_order public.payment_orders%rowtype;
  audit_id bigint;
  refund_id bigint;
begin
  if p_actor_id is null or p_order_id is null then
    raise exception 'Invalid refund request';
  end if;

  select *
  into payment_order
  from public.payment_orders
  where id = p_order_id
  for update;

  if not found or payment_order.status <> 'paid'
    or payment_order.paystack_transaction_id is null then
    raise exception 'Only verified, paid orders can be refunded';
  end if;

  if exists (
    select 1 from public.admin_payment_refunds
    where order_id = payment_order.id
      and status in ('pending', 'processed')
  ) then
    raise exception 'A refund has already been requested for this order';
  end if;

  insert into public.admin_action_audit (
    actor_id, provider, action, target_id, status, details
  )
  values (
    p_actor_id,
    'paystack',
    'full_refund',
    payment_order.reference,
    'pending',
    jsonb_build_object('amount_minor', payment_order.amount_minor)
  )
  returning id into audit_id;

  insert into public.admin_payment_refunds (
    order_id, audit_id, actor_id, amount_minor, status
  )
  values (
    payment_order.id, audit_id, p_actor_id, payment_order.amount_minor, 'pending'
  )
  returning id into refund_id;

  return jsonb_build_object(
    'audit_id', audit_id,
    'refund_id', refund_id,
    'transaction_id', payment_order.paystack_transaction_id,
    'reference', payment_order.reference,
    'amount_minor', payment_order.amount_minor
  );
end;
$$;

revoke all on function public.admin_begin_payment_refund(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.admin_begin_payment_refund(uuid, uuid)
  to service_role;

create or replace function public.admin_update_payment_refund(
  p_refund_record_id bigint,
  p_status text,
  p_paystack_refund_id text default null,
  p_error_message text default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  refund public.admin_payment_refunds%rowtype;
  payment_order public.payment_orders%rowtype;
  selected_course_id text;
begin
  if p_refund_record_id is null or p_status not in ('pending', 'processed', 'failed')
    or (p_error_message is not null and length(p_error_message) > 1000) then
    raise exception 'Invalid refund status';
  end if;

  select *
  into refund
  from public.admin_payment_refunds
  where id = p_refund_record_id
  for update;

  if not found then
    raise exception 'Refund request not found';
  end if;

  if refund.status = 'processed'
    or (refund.status = 'failed' and p_status = 'pending') then
    return;
  end if;

  select *
  into payment_order
  from public.payment_orders
  where id = refund.order_id
  for update;

  if p_status = 'processed' and payment_order.status = 'paid' then
    update public.payment_orders
    set status = 'refunded'
    where id = payment_order.id;

    if payment_order.item_type = 'course' then
      for selected_course_id in
        select jsonb_array_elements_text(payment_order.item_ids)
      loop
        delete from public.enrollments enrollment
        where enrollment.user_id = payment_order.user_id
          and enrollment.course_id::text = selected_course_id
          and enrollment.payment_gateway = 'paystack'
          and not exists (
            select 1
            from public.payment_orders other_order
            where other_order.user_id = payment_order.user_id
              and other_order.item_type = 'course'
              and other_order.status = 'paid'
              and other_order.item_ids @> to_jsonb(array[selected_course_id])
          );
      end loop;
    end if;
  elsif p_status = 'processed' and payment_order.status <> 'refunded' then
    raise exception 'Order is no longer eligible for refund completion';
  end if;

  update public.admin_payment_refunds
  set status = p_status,
      paystack_refund_id = coalesce(p_paystack_refund_id, paystack_refund_id),
      error_message = p_error_message,
      updated_at = now()
  where id = refund.id;

  update public.admin_action_audit
  set status = case p_status
        when 'processed' then 'succeeded'
        when 'failed' then 'failed'
        else 'pending'
      end,
      details = details || jsonb_build_object(
        'refund_status', p_status,
        'paystack_refund_id', p_paystack_refund_id
      ),
      updated_at = now()
  where id = refund.audit_id;
end;
$$;

revoke all on function public.admin_update_payment_refund(bigint, text, text, text)
  from public, anon, authenticated;
grant execute on function public.admin_update_payment_refund(bigint, text, text, text)
  to service_role;

create or replace function public.admin_update_payment_refund_by_provider_id(
  p_paystack_refund_id text,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  selected_refund_id bigint;
begin
  if p_paystack_refund_id is null or length(p_paystack_refund_id) > 128
    or p_status not in ('pending', 'processed', 'failed') then
    raise exception 'Invalid provider refund update';
  end if;

  select id
  into selected_refund_id
  from public.admin_payment_refunds
  where paystack_refund_id = p_paystack_refund_id;

  if selected_refund_id is null then
    raise exception 'Refund request not found';
  end if;

  perform public.admin_update_payment_refund(
    selected_refund_id,
    p_status,
    p_paystack_refund_id,
    null
  );
end;
$$;

revoke all on function public.admin_update_payment_refund_by_provider_id(text, text)
  from public, anon, authenticated;
grant execute on function public.admin_update_payment_refund_by_provider_id(text, text)
  to service_role;

create or replace function public.admin_monthly_dashboard_metrics(p_months integer default 12)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with months as (
    select generate_series(
      date_trunc('month', now() at time zone 'UTC') - make_interval(months => greatest(1, least(p_months, 12)) - 1),
      date_trunc('month', now() at time zone 'UTC'),
      interval '1 month'
    )::date as month_start
  ),
  business as (
    select
      date_trunc('month', created_at at time zone 'UTC')::date as month_start,
      count(*) as total_orders,
      count(*) filter (where status = 'paid') as paid_orders,
      count(*) filter (where status = 'pending') as pending_orders,
      count(*) filter (where status = 'failed') as failed_orders,
      count(*) filter (where status = 'refunded') as refunded_orders,
      count(*) filter (where item_type = 'course' and status = 'paid') as course_orders,
      count(*) filter (where item_type = 'product' and status = 'paid') as product_orders,
      coalesce(sum(amount_minor) filter (where status = 'paid'), 0) as revenue_minor
    from public.payment_orders
    where created_at >= (
      date_trunc('month', now() at time zone 'UTC')
      - make_interval(months => greatest(1, least(p_months, 12)) - 1)
    ) at time zone 'UTC'
    group by 1
  ),
  refunds as (
    select
      date_trunc('month', updated_at at time zone 'UTC')::date as month_start,
      coalesce(sum(amount_minor) filter (where status = 'processed'), 0) as refunded_minor
    from public.admin_payment_refunds
    where updated_at >= (
      date_trunc('month', now() at time zone 'UTC')
      - make_interval(months => greatest(1, least(p_months, 12)) - 1)
    ) at time zone 'UTC'
    group by 1
  ),
  site as (
    select
      month_start,
      jsonb_agg(jsonb_build_object(
        'metric', metric_key,
        'route', route,
        'samples', sample_count,
        'average', case when metric_key = 'page_view' then null
          else round(value_sum / nullif(sample_count, 0), 2) end,
        'max', value_max
      ) order by metric_key, route) as metrics,
      coalesce(sum(sample_count) filter (where metric_key = 'course_download_link'), 0) as course_download_links,
      coalesce(sum(sample_count) filter (where metric_key = 'shop_download_link'), 0) as shop_download_links
    from public.site_monthly_metrics
    where month_start >= date_trunc('month', now() at time zone 'UTC')::date
      - make_interval(months => greatest(1, least(p_months, 12)) - 1)
    group by month_start
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'month', to_char(months.month_start, 'YYYY-MM'),
    'totalOrders', coalesce(business.total_orders, 0),
    'paidOrders', coalesce(business.paid_orders, 0),
    'pendingOrders', coalesce(business.pending_orders, 0),
    'failedOrders', coalesce(business.failed_orders, 0),
    'refundedOrders', coalesce(business.refunded_orders, 0),
    'courseOrders', coalesce(business.course_orders, 0),
    'shopOrders', coalesce(business.product_orders, 0),
    'revenueMinor', coalesce(business.revenue_minor, 0),
    'refundedMinor', coalesce(refunds.refunded_minor, 0),
    'checkoutSuccessRate', case
      when coalesce(business.paid_orders, 0)
        + coalesce(business.failed_orders, 0)
        + coalesce(business.refunded_orders, 0) = 0 then null
      else round(
        (business.paid_orders + business.refunded_orders)::numeric
        / (business.paid_orders + business.failed_orders + business.refunded_orders) * 100,
        1
      )
    end,
    'courseDownloadLinks', coalesce(site.course_download_links, 0),
    'shopDownloadLinks', coalesce(site.shop_download_links, 0),
    'siteMetrics', coalesce(site.metrics, '[]'::jsonb)
  ) order by months.month_start), '[]'::jsonb)
  from months
  left join business using (month_start)
  left join refunds using (month_start)
  left join site using (month_start);
$$;

revoke all on function public.admin_monthly_dashboard_metrics(integer)
  from public, anon, authenticated;
grant execute on function public.admin_monthly_dashboard_metrics(integer)
  to service_role;
