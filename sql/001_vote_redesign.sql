-- =============================================================================
-- 001_vote_redesign.sql
-- ПРЕРАБОТКА НА ГРАЖДАНСКОТО ГЛАСУВАНЕ
-- =============================================================================
-- Проблем: броячите votes_still_there / votes_fixed се УВЕЛИЧАВАХА от
-- приложението (четене -> промяна -> запис). Това правеше смяната на глас
-- невъзможна и създаваше състезание при едновременни гласове - два гласа в
-- един и същи момент се презаписваха и прагът от 3 можеше да бъде пропуснат.
--
-- Решение: signal_votes става ЕДИНСТВЕНИЯТ източник на истина.
--   * един ред на (signal_id, user_ip) -> един глас на човек
--   * повторно гласуване ПРЕЗАПИСВА реда -> гласът се сменя, не се добавя
--   * броячите се ИЗЧИСЛЯВАТ от таблицата -> не могат да се разминат
--
-- Изпълнете ПРЕДИ да бъде качен новият код на api/vote-signals.js.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Уникално ограничение: един глас на IP за даден сигнал
-- -----------------------------------------------------------------------------
-- Създава се само ако все още липсва. ON CONFLICT в стъпка 2 изисква точно
-- такъв уникален индекс, за да може да презапише съществуващия глас.
do $$
declare
  has_unique boolean;
begin
  select exists (
    select 1
    from pg_index i
    where i.indrelid = 'public.signal_votes'::regclass
      and i.indisunique
      -- ВНИМАНИЕ: pg_attribute.attname е от тип "name", а не "text".
      -- Без ::text сравнението е name[] = text[] и Postgres няма такъв оператор.
      and (
        select array_agg(a.attname::text order by a.attname::text)
        from unnest(i.indkey) as k(attnum)
        join pg_attribute a
          on a.attrelid = i.indrelid and a.attnum = k.attnum
      ) = array['signal_id', 'user_ip']::text[]
  ) into has_unique;

  if has_unique then
    raise notice 'Уникалното ограничение (signal_id, user_ip) вече съществува.';
  else
    alter table public.signal_votes
      add constraint signal_votes_signal_ip_unique unique (signal_id, user_ip);
    raise notice 'Създадено е уникално ограничение (signal_id, user_ip).';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 2. Функция за гласуване - цялата операция в ЕДНА транзакция
-- -----------------------------------------------------------------------------
create or replace function public.cast_vote(
  p_signal_id bigint,
  p_user_ip   text,
  p_vote_type text
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status       text;
  v_previous     text;
  v_still        int;
  v_fixed        int;
  v_new_status   text;
begin
  -- Валидация на типа глас
  if p_vote_type is null or p_vote_type not in ('still_there', 'fixed') then
    return json_build_object('ok', false, 'error', 'invalid_vote_type');
  end if;

  if p_user_ip is null or length(trim(p_user_ip)) = 0 then
    return json_build_object('ok', false, 'error', 'missing_voter');
  end if;

  -- FOR UPDATE заключва реда на сигнала до края на транзакцията. Така два
  -- едновременни гласа се обработват последователно и нито един не се губи.
  select status into v_status
  from public.signals
  where id = p_signal_id
  for update;

  if not found then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;

  -- По решен сигнал не се гласува и гласът НЕ може да се сменя.
  if v_status = 'Решен' then
    return json_build_object('ok', false, 'error', 'already_resolved');
  end if;

  -- Запомняме предишния глас, за да знаем дали е смяна или нов глас.
  select vote_type into v_previous
  from public.signal_votes
  where signal_id = p_signal_id and user_ip = p_user_ip;

  -- Един ред на (сигнал, IP). Повторното гласуване презаписва вида на гласа,
  -- НЕ добавя втори ред - затова един човек никога не може да събере 3 гласа.
  insert into public.signal_votes (signal_id, user_ip, vote_type)
  values (p_signal_id, p_user_ip, p_vote_type)
  on conflict (signal_id, user_ip)
  do update set vote_type = excluded.vote_type,
                created_at = now();

  -- Броячите се ИЗЧИСЛЯВАТ от реалните гласове - не могат да се разминат.
  select
    count(*) filter (where vote_type = 'still_there'),
    count(*) filter (where vote_type = 'fixed')
  into v_still, v_fixed
  from public.signal_votes
  where signal_id = p_signal_id;

  -- Праг: 3 РАЗЛИЧНИ гласоподаватели за "Оправен е".
  v_new_status := case when v_fixed >= 3 then 'Решен' else v_status end;

  update public.signals
  set votes_still_there = v_still,
      votes_fixed       = v_fixed,
      status            = v_new_status,
      updated_at        = now()
  where id = p_signal_id;

  return json_build_object(
    'ok',                true,
    'changed',           (v_previous is not null and v_previous is distinct from p_vote_type),
    'previous_vote',     v_previous,
    'vote_type',         p_vote_type,
    'votes_still_there', v_still,
    'votes_fixed',       v_fixed,
    'status',            v_new_status
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Права за изпълнение
-- -----------------------------------------------------------------------------
-- Бекендът извиква функцията със SERVICE_ROLE ключ. Ключът anon се дава само
-- като резервен вариант - той никога не достига браузъра, защото фронтендът
-- работи изключително през /api маршрутите.
grant execute on function public.cast_vote(bigint, text, text) to service_role, anon;

-- -----------------------------------------------------------------------------
-- 4. Изравняване на съществуващите броячи с реалните гласове
-- -----------------------------------------------------------------------------
-- Ако старата логика е допуснала разминаване, тук то се коригира еднократно.
update public.signals s
set votes_still_there = coalesce(v.still_there, 0),
    votes_fixed       = coalesce(v.fixed, 0)
from (
  select
    signal_id,
    count(*) filter (where vote_type = 'still_there') as still_there,
    count(*) filter (where vote_type = 'fixed')       as fixed
  from public.signal_votes
  group by signal_id
) v
where s.id = v.signal_id
  and (s.votes_still_there is distinct from coalesce(v.still_there, 0)
    or s.votes_fixed       is distinct from coalesce(v.fixed, 0));
