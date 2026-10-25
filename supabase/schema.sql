-- PAINT! database schema (Supabase / Postgres)

-- Only black cells are stored; a missing row is a white cell.
create table public.cells (
  x int not null,
  y int not null,
  painted_at timestamptz not null default now(),
  primary key (x, y)
);
-- DELETE realtime events need the old row's x/y
alter table public.cells replica identity full;

-- Single-row shared paint pool. Invariant: remaining = total - count(cells).
create table public.pool (
  id int primary key default 1 check (id = 1),
  remaining int not null check (remaining >= 0),
  total int not null
);
insert into public.pool (id, remaining, total) values (1, 10000, 10000);

alter table public.cells enable row level security;
alter table public.pool enable row level security;
create policy "cells readable" on public.cells for select to anon, authenticated using (true);
create policy "pool readable" on public.pool for select to anon, authenticated using (true);

-- Atomic toggle: locking the pool row serializes all paint operations,
-- so the pool can never go negative or be double-spent.
create or replace function public.toggle_cell(px int, py int)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  rem int;
  deleted int;
begin
  if abs(px) > 1000000 or abs(py) > 1000000 then
    return json_build_object('ok', false, 'error', 'out_of_bounds');
  end if;

  select remaining into rem from pool where id = 1 for update;

  delete from cells where x = px and y = py;
  get diagnostics deleted = row_count;

  if deleted > 0 then
    update pool set remaining = remaining + 1 where id = 1 returning remaining into rem;
    return json_build_object('ok', true, 'black', false, 'remaining', rem);
  end if;

  if rem <= 0 then
    return json_build_object('ok', false, 'error', 'no_paint', 'remaining', rem);
  end if;

  insert into cells (x, y) values (px, py);
  update pool set remaining = remaining - 1 where id = 1 returning remaining into rem;
  return json_build_object('ok', true, 'black', true, 'remaining', rem);
end;
$$;

-- The pool caps how many cells can be black, so the whole board fits in one
-- small JSON payload ([[x,y], ...]).
create or replace function public.get_all_cells()
returns json
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(json_agg(json_build_array(x, y)), '[]'::json) from cells;
$$;

revoke all on function public.toggle_cell(int, int) from public;
revoke all on function public.get_all_cells() from public;
grant execute on function public.toggle_cell(int, int) to anon, authenticated;
grant execute on function public.get_all_cells() to anon, authenticated;

alter publication supabase_realtime add table public.cells, public.pool;
