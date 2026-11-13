create or replace function public.admin_instructor_report(p_instructor text)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with instructor_courses as (
    select id::text as course_id, title, instructor
    from public.courses
    where btrim(instructor) = btrim(p_instructor)
  ),
  enrollments as (
    select course_id::text as course_id, count(*) as enrollment_count
    from public.enrollments
    group by course_id::text
  ),
  course_orders as (
    select
      course.course_id,
      count(*) filter (where payment.status = 'paid') as paid_orders,
      count(*) filter (where payment.status = 'refunded') as refunded_orders,
      coalesce(sum(payment.amount_minor) filter (where payment.status = 'paid'), 0) as gross_sales_minor
    from instructor_courses course
    left join public.payment_orders payment
      on payment.item_type = 'course'
      and payment.item_ids @> jsonb_build_array(course.course_id)
    group by course.course_id
  ),
  course_refunds as (
    select
      course.course_id,
      coalesce(sum(refund.amount_minor), 0) as refunded_minor
    from instructor_courses course
    join public.payment_orders payment
      on payment.item_type = 'course'
      and payment.item_ids @> jsonb_build_array(course.course_id)
    join public.admin_payment_refunds refund
      on refund.order_id = payment.id
      and refund.status = 'processed'
    group by course.course_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'courseId', course.course_id,
    'courseTitle', course.title,
    'enrollments', coalesce(enrollments.enrollment_count, 0),
    'paidOrders', coalesce(course_orders.paid_orders, 0),
    'refundedOrders', coalesce(course_orders.refunded_orders, 0),
    'grossSalesMinor', coalesce(course_orders.gross_sales_minor, 0),
    'refundedMinor', coalesce(course_refunds.refunded_minor, 0),
    'netSalesMinor', coalesce(course_orders.gross_sales_minor, 0)
      - coalesce(course_refunds.refunded_minor, 0)
  ) order by course.title), '[]'::jsonb)
  from instructor_courses course
  left join enrollments using (course_id)
  left join course_orders using (course_id)
  left join course_refunds using (course_id);
$$;

revoke all on function public.admin_instructor_report(text)
  from public, anon, authenticated;
grant execute on function public.admin_instructor_report(text)
  to service_role;
