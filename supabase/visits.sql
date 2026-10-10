-- 📸 임장 기록 (2026-10-10) — Supabase SQL Editor에 전체 붙여넣고 Run (여러 번 실행해도 안전)
-- ※ approval.sql(승인제)을 먼저 실행해야 합니다 (is_member · is_admin 함수 사용)
--
--  · visits: 임장 1회 = 1행 (단지, 별점, 체크리스트, 메모, 사진 경로, 공개 범위)
--  · 사진: 비공개 저장소 'visits' 버킷, 경로 = {내 user_id}/{임의 이름}.jpg (미리보기 = ..._t.jpg)
--  · 볼 수 있는 사람: 본인 + (그룹 공유한 기록이면) 승인된 멤버. 앱은 1시간짜리 임시 주소로만 사진을 엶

-- ───────── 1. 임장 기록 표 ─────────
create table if not exists public.visits (
  id           bigint generated always as identity primary key,
  complex_code text not null,
  user_id      uuid not null default auth.uid() references public.members(user_id) on delete cascade,
  visited_at   timestamptz not null default now(),
  rating       smallint check (rating between 1 and 5),
  checks       jsonb not null default '{}'::jsonb,          -- {"향":1,"소음":2,...} 1=◎ 2=○ 3=△
  memo         text not null default '' check (char_length(memo) <= 1000),
  photos       jsonb not null default '[]'::jsonb,          -- ["uid/xxx.jpg", ...] (미리보기는 _t.jpg)
  shared       boolean not null default true,
  created_at   timestamptz not null default now()
);
create index if not exists visits_complex_idx on public.visits (complex_code, visited_at desc);
create index if not exists visits_user_idx on public.visits (user_id);

alter table public.visits enable row level security;
drop policy if exists "임장 조회" on public.visits;
create policy "임장 조회" on public.visits for select to authenticated
  using (user_id = auth.uid() or (shared and public.is_member()));
drop policy if exists "임장 작성" on public.visits;
create policy "임장 작성" on public.visits for insert to authenticated
  with check (public.is_member() and user_id = auth.uid());
drop policy if exists "내 임장 수정" on public.visits;
create policy "내 임장 수정" on public.visits for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "내 임장 삭제" on public.visits;
create policy "내 임장 삭제" on public.visits for delete to authenticated using (user_id = auth.uid() or public.is_admin());

-- ───────── 2. 사진 저장소 (비공개) ─────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('visits', 'visits', false, 3145728, array['image/jpeg', 'image/webp'])   -- 장당 최대 3MB (앱이 300KB로 줄여서 올림)
on conflict (id) do update set public = false, file_size_limit = 3145728, allowed_mime_types = array['image/jpeg', 'image/webp'];

-- 올리기: 승인된 멤버가 자기 폴더에만
drop policy if exists "임장 사진 올리기" on storage.objects;
create policy "임장 사진 올리기" on storage.objects for insert to authenticated
  with check (bucket_id = 'visits' and public.is_member() and (storage.foldername(name))[1] = auth.uid()::text);

-- 보기: 내 사진 + 그룹 공유한 임장 기록에 들어 있는 사진
drop policy if exists "임장 사진 보기" on storage.objects;
create policy "임장 사진 보기" on storage.objects for select to authenticated
  using (bucket_id = 'visits' and (
    (storage.foldername(name))[1] = auth.uid()::text
    or (public.is_member() and exists (
      select 1 from public.visits v
       where v.shared and v.photos ? regexp_replace(name, '_t\.jpg$', '.jpg')))));

-- 지우기: 내 사진만 (관리자는 기록 삭제로 정리)
drop policy if exists "임장 사진 지우기" on storage.objects;
create policy "임장 사진 지우기" on storage.objects for delete to authenticated
  using (bucket_id = 'visits' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));

-- ───────── 3. 저장 공간 사용량 (관리자 화면 표시용) ─────────
create or replace function public.visits_storage_usage() returns bigint
language sql stable security definer set search_path = public, storage as $$
  select case when public.is_admin()
    then coalesce(sum((metadata->>'size')::bigint), 0) else null end
  from storage.objects where bucket_id = 'visits';
$$;
grant execute on function public.visits_storage_usage() to authenticated;
