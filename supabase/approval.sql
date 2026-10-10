-- 🔐 승인제 가입 + 관리자 (2026-10-10) — Supabase SQL Editor에 전체 붙여넣고 Run (여러 번 실행해도 안전)
--
--  · 초대코드 대신: 카카오 로그인 → 가입 요청(대기) → 관리자가 승인해야 앱 사용 가능
--  · 이미 가입한 사람은 처음 실행할 때 자동으로 '승인' 상태
--  · 관리자: 승인된 멤버 중 아직 관리자가 없을 때 앱에서 "관리자로 등록"을 누른 첫 사람 (그 뒤엔 관리자만 다른 사람을 관리자로 지정)
--  · 같은 카카오 계정이면 어느 기기에서 로그인해도 관리자
--  · 관심단지 그룹 공유(share_favorites.sql)도 함께 적용

-- ───────── 1. 멤버 상태·역할 칸 ─────────
alter table public.members add column if not exists status     text not null default 'pending';
alter table public.members add column if not exists role       text not null default 'member';
alter table public.members add column if not exists decided_at timestamptz;

do $$ begin
  -- 처음 한 번만: 기존 가입자 = 승인
  if not exists (select 1 from public.app_config where key = 'approval_migrated') then
    update public.members set status = 'approved', decided_at = now();
    insert into public.app_config (key, value) values ('approval_migrated', now()::text);
  end if;
end $$;

alter table public.members drop constraint if exists members_status_chk;
alter table public.members add  constraint members_status_chk check (status in ('pending', 'approved', 'rejected'));
alter table public.members drop constraint if exists members_role_chk;
alter table public.members add  constraint members_role_chk check (role in ('member', 'admin'));

-- 본인이 바꿀 수 있는 건 닉네임뿐 (상태·역할을 스스로 '승인'·'관리자'로 못 바꾸게)
revoke update on public.members from authenticated, anon;
grant  update (nickname) on public.members to authenticated;

-- ───────── 2. 권한 확인 함수 ─────────
-- 승인된 멤버만 '멤버' (리마크·공유 관심단지 등 모든 그룹 정보가 이 함수로 보호됨)
create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where user_id = auth.uid() and status = 'approved');
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where user_id = auth.uid() and status = 'approved' and role = 'admin');
$$;

-- ───────── 3. 가입 요청 · 승인 · 관리자 지정 ─────────
drop function if exists public.join_group(text, text);          -- 초대코드 가입 종료

create or replace function public.request_join(nick text) returns text
language plpgsql security definer set search_path = public as $$
declare s text;
begin
  if auth.uid() is null then raise exception '로그인이 필요합니다'; end if;
  if char_length(trim(nick)) not between 1 and 20 then raise exception '닉네임은 1~20자'; end if;
  insert into members (user_id, nickname, status) values (auth.uid(), trim(nick), 'pending')
  on conflict (user_id) do update
    set nickname = excluded.nickname,
        status = case when members.status = 'rejected' then 'pending' else members.status end,   -- 거절된 사람은 다시 요청 가능
        joined_at = case when members.status = 'rejected' then now() else members.joined_at end
  returning status into s;
  return s;
end;
$$;

create or replace function public.decide_member(target uuid, approve boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception '관리자만 할 수 있습니다'; end if;
  if target = auth.uid() then raise exception '자기 자신은 바꿀 수 없습니다'; end if;
  update members set status = case when approve then 'approved' else 'rejected' end,
                     role = case when approve then role else 'member' end,
                     decided_at = now()
   where user_id = target;
end;
$$;

create or replace function public.set_admin(target uuid, make boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception '관리자만 할 수 있습니다'; end if;
  if not make and (select count(*) from members where role = 'admin' and status = 'approved') <= 1
     and exists (select 1 from members where user_id = target and role = 'admin') then
    raise exception '관리자가 최소 한 명은 있어야 합니다';
  end if;
  update members set role = case when make then 'admin' else 'member' end
   where user_id = target and status = 'approved';
end;
$$;

-- 관리자가 아직 한 명도 없을 때만: 승인된 멤버가 스스로 관리자 등록 (최초 1회)
create or replace function public.claim_admin() returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_member() then raise exception '승인된 멤버만 가능합니다'; end if;
  if exists (select 1 from members where role = 'admin') then return false; end if;
  update members set role = 'admin' where user_id = auth.uid();
  return true;
end;
$$;

-- 관리자가 있는지 (관리자 등록 버튼 표시용)
create or replace function public.admin_exists() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where role = 'admin' and status = 'approved');
$$;

-- ───────── 4. 멤버 목록 보기 규칙 ─────────
-- 본인 · 관리자(대기자 포함 전체) · 승인된 멤버끼리(승인된 사람만)
drop policy if exists "멤버끼리 조회" on public.members;
create policy "멤버끼리 조회" on public.members for select to authenticated
  using (user_id = auth.uid() or public.is_admin() or (public.is_member() and status = 'approved'));

-- ───────── 5. 관심단지 그룹 공유 (share_favorites.sql 내용) ─────────
alter table public.favorites add column if not exists shared boolean not null default true;
drop policy if exists "그룹 관심단지 조회" on public.favorites;
create policy "그룹 관심단지 조회" on public.favorites for select to authenticated
  using (shared and public.is_member());

grant execute on function public.request_join(text)          to authenticated;
grant execute on function public.decide_member(uuid, boolean) to authenticated;
grant execute on function public.set_admin(uuid, boolean)    to authenticated;
grant execute on function public.claim_admin()               to authenticated;
grant execute on function public.admin_exists()              to authenticated;
grant execute on function public.is_member()                 to authenticated;
grant execute on function public.is_admin()                  to authenticated;
