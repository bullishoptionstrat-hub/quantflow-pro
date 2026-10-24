-- The entry price a signal is measured from, persisted the moment it is taken.
--
-- Until now the entry mark reached durable storage only on the first outcome
-- row — written at the M15 checkpoint, fifteen minutes after the decision. A
-- process that stopped in between took the mark with it, and recovery, which
-- never re-takes an entry price (a price from after the decision is
-- lookahead), could only grade every horizon UNGRADED. Render's free tier
-- spins a service down after fifteen minutes without inbound traffic and
-- "might restart a Free web service at any time"; a paid instance still
-- restarts on every deploy. So the window this row closes is not hypothetical.
--
-- One row per signal, written once. The entry is a fact about one instant:
-- a second write with a different price is not a correction, it is a second
-- process that took its own mark later, and the first observation wins.
-- Append-only by trigger, like `signal_outcomes`, and default-deny RLS like
-- every table the recorder and grader write.

begin;

create table if not exists public.signal_entry_marks (
  signal_key   text primary key references public.signal_history(signal_key) on delete restrict,
  entry_mark   numeric not null,
  mark_source  text not null,
  -- When the price was true, on the vendor's clock — not when it was received.
  mark_at      timestamptz not null,
  recorded_at  timestamptz not null default now(),

  constraint signal_entry_marks_price_positive check (entry_mark > 0),
  constraint signal_entry_marks_source_named check (length(trim(mark_source)) > 0)
);

comment on table public.signal_entry_marks is
  'The entry price each real signal is graded from, written when it was taken '
  'so a restart before the first checkpoint does not lose it. Write-once.';

create or replace function public.enforce_entry_mark_immutability()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception
    'signal_entry_marks is write-once: % on the entry mark for % rejected.',
    tg_op, old.signal_key;
end;
$$;

drop trigger if exists trg_entry_mark_immutability on public.signal_entry_marks;
create trigger trg_entry_mark_immutability
  before update or delete on public.signal_entry_marks
  for each row execute function public.enforce_entry_mark_immutability();

alter table public.signal_entry_marks enable row level security;
alter table public.signal_entry_marks force row level security;

commit;
