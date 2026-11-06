-- Dados FICTÍCIOS com o mesmo formato do estado atual de produção:
-- 11 meses publicados; outubro com 3 revisões e novembro com 4 (as anteriores
-- já sobrescritas, só com metadados em painel_publications), e uma republicação
-- idêntica em novembro (r2 e r3 com o mesmo checksum).
grant all on public.painel_months, public.painel_current, public.painel_publications, public.painel_publicadores to service_role;

insert into public.painel_publicadores (email) values ('publicador@teste.local');

insert into public.painel_months (period_key, period_year, period_month, file_name, checksum, data, summary, revision, published_at)
select to_char(d, 'YYYY-MM'), extract(year from d)::smallint, extract(month from d)::smallint,
       'arquivo ' || to_char(d, 'MM') || '.xlsx', 'ck' || to_char(d, 'MM') || 'r1',
       jsonb_build_object('file', 'arquivo ' || to_char(d, 'MM') || '.xlsx', 'period', jsonb_build_object('m', extract(month from d)::int - 1, 'y', 2026), 'ftrGeral', 0.9),
       jsonb_build_object('key', to_char(d, 'YYYY-MM')), 1, d
  from generate_series(date '2026-01-01', date '2026-09-01', interval '1 month') d;

insert into public.painel_months values
  ('2026-10', 2026, 10, 'arquivo 10.xlsx', 'ck10r3', '{"file":"arquivo 10.xlsx","period":{"m":9,"y":2026},"ftrGeral":0.91}', '{"key":"2026-10"}', 3, '2026-11-05 17:31:13+00'),
  ('2026-11', 2026, 11, 'arquivo 11.xlsx', 'ck11r4', '{"file":"arquivo 11.xlsx","period":{"m":10,"y":2026},"ftrGeral":0.88}', '{"key":"2026-11"}', 4, '2026-11-06 17:53:36+00');

insert into public.painel_current values (1, '2026-11', 'arquivo 11.xlsx', 'ck11r4', '2026-11-06 17:53:36+00');

insert into public.painel_publications (period_key, file_name, checksum, published_by, set_current, replaced, revision, published_at)
select period_key, file_name, checksum, 'publicador@teste.local', true, false, 1, published_at
  from public.painel_months where revision = 1 order by period_key;
insert into public.painel_publications (period_key, file_name, checksum, published_by, set_current, replaced, revision, published_at) values
  ('2026-10', 'arquivo 10.xlsx', 'ck10r1', 'publicador@teste.local', true, false, 1, '2026-10-28 18:36:08+00'),
  ('2026-10', 'arquivo 10.xlsx', 'ck10r2', 'publicador@teste.local', true, true,  2, '2026-10-28 18:38:28+00'),
  ('2026-10', 'arquivo 10.xlsx', 'ck10r3', 'publicador@teste.local', true, true,  3, '2026-11-05 17:31:13+00'),
  ('2026-11', 'arquivo 11.xlsx', 'ck11r1', 'publicador@teste.local', true, false, 1, '2026-11-05 17:31:18+00'),
  ('2026-11', 'arquivo 11.xlsx', 'ck11rX', 'publicador@teste.local', true, true,  2, '2026-11-05 17:53:22+00'),
  ('2026-11', 'arquivo 11.xlsx', 'ck11rX', 'publicador@teste.local', true, true,  3, '2026-11-05 19:32:11+00'),
  ('2026-11', 'arquivo 11.xlsx', 'ck11r4', 'publicador@teste.local', true, true,  4, '2026-11-06 17:53:36+00');
