-- 서울 아파트 입지 — Supabase 데이터베이스 구조
-- Supabase 대시보드 → SQL Editor → 새 쿼리에 전체 붙여넣고 Run
-- (여러 번 실행해도 안전하도록 작성됨)

-- ───────── 그룹 멤버 (초대코드로 가입한 사람만) ─────────
create table if not exists public.members (
  user_id   uuid primary key references auth.users on delete cascade,
  nickname  text not null unique check (char_length(nickname) between 1 and 20),
  joined_at timestamptz not null default now()
);

-- 초대코드 보관 (누구도 직접 읽을 수 없음 — join_group 함수만 확인)
create table if not exists public.app_config (
  key   text primary key,
  value text not null
);

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where user_id = auth.uid());
$$;

create or replace function public.join_group(code text, nick text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception '로그인이 필요합니다'; end if;
  if not exists (select 1 from app_config where key = 'invite_code' and value = code) then
    raise exception '초대코드가 올바르지 않습니다';
  end if;
  insert into members (user_id, nickname) values (auth.uid(), trim(nick))
  on conflict (user_id) do update set nickname = excluded.nickname;
end;
$$;

-- ───────── 리마크 (그룹 멤버끼리 공유) ─────────
create table if not exists public.remarks (
  id           bigint generated always as identity primary key,
  complex_code text not null,
  user_id      uuid not null default auth.uid() references public.members(user_id) on delete cascade,
  kind         text not null check (kind in ('추천', '주의', '임장', '매수검토', '코멘트')),
  body         text not null default '' check (char_length(body) <= 500),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists remarks_complex_idx on public.remarks (complex_code);
create index if not exists remarks_created_idx on public.remarks (created_at desc);

-- ───────── 관심단지 · 메모 (본인만) ─────────
create table if not exists public.favorites (
  user_id      uuid not null default auth.uid() references auth.users on delete cascade,
  complex_code text not null,
  created_at   timestamptz not null default now(),
  primary key (user_id, complex_code)
);
create table if not exists public.memos (
  user_id      uuid not null default auth.uid() references auth.users on delete cascade,
  complex_code text not null,
  body         text not null default '' check (char_length(body) <= 5000),
  updated_at   timestamptz not null default now(),
  primary key (user_id, complex_code)
);

-- ───────── 보안 규칙 (RLS) ─────────
alter table public.members    enable row level security;
alter table public.app_config enable row level security;   -- 정책 없음 = 아무도 직접 접근 불가
alter table public.remarks    enable row level security;
alter table public.favorites  enable row level security;
alter table public.memos      enable row level security;

drop policy if exists "멤버끼리 조회" on public.members;
create policy "멤버끼리 조회" on public.members for select to authenticated
  using (public.is_member() or user_id = auth.uid());
drop policy if exists "내 닉네임 수정" on public.members;
create policy "내 닉네임 수정" on public.members for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "멤버만 리마크 조회" on public.remarks;
create policy "멤버만 리마크 조회" on public.remarks for select to authenticated using (public.is_member());
drop policy if exists "멤버만 리마크 작성" on public.remarks;
create policy "멤버만 리마크 작성" on public.remarks for insert to authenticated
  with check (public.is_member() and user_id = auth.uid());
drop policy if exists "내 리마크 수정" on public.remarks;
create policy "내 리마크 수정" on public.remarks for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "내 리마크 삭제" on public.remarks;
create policy "내 리마크 삭제" on public.remarks for delete to authenticated using (user_id = auth.uid());

drop policy if exists "내 관심단지" on public.favorites;
create policy "내 관심단지" on public.favorites for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "내 메모" on public.memos;
create policy "내 메모" on public.memos for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

grant execute on function public.join_group(text, text) to authenticated;
grant execute on function public.is_member() to authenticated;
