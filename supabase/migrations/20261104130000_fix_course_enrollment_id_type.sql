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
