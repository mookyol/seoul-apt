-- 👥 관심단지 그룹 공유 (2026-10-06 추가) — Supabase SQL Editor에서 한 번 실행
-- 각자 "그룹에 공유"를 켠 관심단지(shared = true)는 같은 그룹 멤버가 볼 수 있음. 메모는 여전히 본인만.

alter table public.favorites add column if not exists shared boolean not null default true;

drop policy if exists "그룹 관심단지 조회" on public.favorites;
create policy "그룹 관심단지 조회" on public.favorites for select to authenticated
  using (shared and public.is_member());
