-- ICHA AI Studio: Supabase schema
-- Run in Supabase SQL Editor. Never expose the service-role key in browser code.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  role text not null default 'customer' check (role in ('customer','admin')),
  status text not null default 'active' check (status in ('active','suspended')),
  credits integer not null default 0 check (credits >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.packages (
  id text primary key,
  name text not null,
  price_ngn integer not null check (price_ngn >= 0),
  credits integer not null check (credits > 0),
  active boolean not null default true
);

insert into public.packages (id,name,price_ngn,credits) values
 ('starter','Starter',2000,20),
 ('creator','Creator',5000,60),
 ('business','Business',10000,150)
on conflict (id) do nothing;

create table if not exists public.payment_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  package_id text not null references public.packages(id),
  amount_ngn integer not null check (amount_ngn > 0),
  payment_reference text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  admin_note text,
  reviewed_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create table if not exists public.credit_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  payment_request_id uuid references public.payment_requests(id),
  amount integer not null,
  reason text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.generation_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('video','voice','voice_clone')),
  status text not null default 'queued',
  provider_job_id text,
  credits_charged integer not null default 0,
  created_at timestamptz not null default now()
);

create or replace function public.is_studio_admin()
returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin' and status = 'active') $$;

create or replace function public.handle_new_studio_user()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id,email) values (new.id, coalesce(new.email,''));
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_studio on auth.users;
create trigger on_auth_user_created_studio after insert on auth.users
for each row execute procedure public.handle_new_studio_user();

alter table public.profiles enable row level security;
alter table public.packages enable row level security;
alter table public.payment_requests enable row level security;
alter table public.credit_ledger enable row level security;
alter table public.generation_jobs enable row level security;

drop policy if exists "profile read own or admin" on public.profiles;
create policy "profile read own or admin" on public.profiles for select to authenticated
using (id = auth.uid() or public.is_studio_admin());
drop policy if exists "packages visible" on public.packages;
create policy "packages visible" on public.packages for select to anon, authenticated using (active or public.is_studio_admin());
drop policy if exists "customer creates own payment request" on public.payment_requests;
create policy "customer creates own payment request" on public.payment_requests for insert to authenticated
with check (user_id = auth.uid() and status = 'pending');
drop policy if exists "payment request read own or admin" on public.payment_requests;
create policy "payment request read own or admin" on public.payment_requests for select to authenticated
using (user_id = auth.uid() or public.is_studio_admin());
drop policy if exists "ledger read own or admin" on public.credit_ledger;
create policy "ledger read own or admin" on public.credit_ledger for select to authenticated
using (user_id = auth.uid() or public.is_studio_admin());
drop policy if exists "jobs read own or admin" on public.generation_jobs;
create policy "jobs read own or admin" on public.generation_jobs for select to authenticated
using (user_id = auth.uid() or public.is_studio_admin());

-- Approval is atomic: only an active admin can approve a pending request;
-- credits are added exactly once in the same database transaction.
create or replace function public.review_studio_payment(p_request_id uuid, p_approve boolean, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  req public.payment_requests%rowtype;
  credit_amount integer;
begin
  if not public.is_studio_admin() then
    raise exception 'admin_only';
  end if;
  select * into req from public.payment_requests where id = p_request_id for update;
  if not found then raise exception 'request_not_found'; end if;
  if req.status <> 'pending' then raise exception 'request_already_reviewed'; end if;

  if p_approve then
    select credits into credit_amount from public.packages where id = req.package_id and active = true;
    if credit_amount is null then raise exception 'package_unavailable'; end if;
    update public.profiles set credits = credits + credit_amount where id = req.user_id;
    insert into public.credit_ledger(user_id,payment_request_id,amount,reason)
    values(req.user_id,req.id,credit_amount,'Manual payment approved');
    update public.payment_requests
      set status='approved', admin_note=p_note, reviewed_by=auth.uid(), reviewed_at=now()
      where id=req.id;
  else
    update public.payment_requests
      set status='rejected', admin_note=p_note, reviewed_by=auth.uid(), reviewed_at=now()
      where id=req.id;
  end if;
  return jsonb_build_object('request_id',req.id,'status',case when p_approve then 'approved' else 'rejected' end);
end;
$$;

revoke all on function public.review_studio_payment(uuid,boolean,text) from public;
grant execute on function public.review_studio_payment(uuid,boolean,text) to authenticated;
