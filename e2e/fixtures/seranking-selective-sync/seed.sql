INSERT INTO organization (id, name, slug, created_at)
VALUES ('delegated-local-admin', 'admin workspace', 'delegated-admin-6c6f63616c2d61646d696e', 1735689600);
INSERT INTO projects (id, organization_id, name, domain, location_code, language_code)
VALUES ('8814bf28-0081-48e6-8f07-a4774efe4d15', 'delegated-local-admin', 'Matchday Sports', 'matchday.example', 2818, 'ar');
INSERT INTO rank_tracking_configs (id, project_id, domain, location_code, language_code, devices, serp_depth, schedule_interval)
VALUES ('08cbc9b1-82b4-4b5b-984a-0f7e57f8296d', '8814bf28-0081-48e6-8f07-a4774efe4d15', 'matchday.example', 2818, 'ar', 'both', 100, 'manual');
INSERT INTO rank_tracking_keywords (id, config_id, keyword, search_volume, keyword_difficulty)
VALUES
  ('428239c7-eed4-4d30-82ea-c3133db4682f', '08cbc9b1-82b4-4b5b-984a-0f7e57f8296d', 'إنشاء ملاعب كرة القدم', 720, 24),
  ('a47f201a-3f5e-43d8-841e-4ca02cb2c828', '08cbc9b1-82b4-4b5b-984a-0f7e57f8296d', 'أرضيات ملاعب بادل', 590, 18),
  ('f3900d66-aeb5-4f01-b081-c63318fae18d', '08cbc9b1-82b4-4b5b-984a-0f7e57f8296d', 'ملاعب تنس خارجية', 480, 21),
  ('698b43a4-698a-4a57-ac8e-68b0a87a6506', '08cbc9b1-82b4-4b5b-984a-0f7e57f8296d', 'صيانة الملاعب الرياضية', 390, 19);
INSERT INTO rank_tracking_targets (id, organization_id, local_project_id, tracking_config_id, country_code, language_code, device)
VALUES
  ('fixture-desktop', 'delegated-local-admin', '8814bf28-0081-48e6-8f07-a4774efe4d15', '08cbc9b1-82b4-4b5b-984a-0f7e57f8296d', 'eg', 'ar', 'desktop'),
  ('fixture-mobile', 'delegated-local-admin', '8814bf28-0081-48e6-8f07-a4774efe4d15', '08cbc9b1-82b4-4b5b-984a-0f7e57f8296d', 'eg', 'ar', 'mobile');
INSERT INTO rank_tracking_keyword_targets (id, tracking_keyword_id, tracking_target_id)
VALUES
  ('fixture-assignment-1', '428239c7-eed4-4d30-82ea-c3133db4682f', 'fixture-desktop'),
  ('fixture-assignment-2', '428239c7-eed4-4d30-82ea-c3133db4682f', 'fixture-mobile'),
  ('fixture-assignment-3', 'a47f201a-3f5e-43d8-841e-4ca02cb2c828', 'fixture-desktop'),
  ('fixture-assignment-4', 'f3900d66-aeb5-4f01-b081-c63318fae18d', 'fixture-mobile');
INSERT INTO se_ranking_account_bindings (id, organization_id, account_fingerprint)
VALUES ('fixture-account', 'delegated-local-admin', '14a329fe58e28b1fb1159cd93c075b5e2ae41db1cdd854017278b1a15f59ce4e');
INSERT INTO se_ranking_project_bindings (id, organization_id, local_project_id, provider_account_binding_id, remote_site_id, status)
VALUES ('fixture-project-binding', 'delegated-local-admin', '8814bf28-0081-48e6-8f07-a4774efe4d15', 'fixture-account', 13188608, 'connected');
INSERT INTO se_ranking_engine_bindings (id, project_binding_id, tracking_target_id, remote_site_engine_id, remote_search_engine_id, remote_language_code)
VALUES
  ('fixture-engine-desktop', 'fixture-project-binding', 'fixture-desktop', 539194, 610, 'ar'),
  ('fixture-engine-mobile', 'fixture-project-binding', 'fixture-mobile', 545914, 611, 'ar');
INSERT INTO se_ranking_keyword_mappings (id, project_binding_id, tracking_keyword_id, remote_keyword_id)
VALUES ('fixture-mapping', 'fixture-project-binding', '698b43a4-698a-4a57-ac8e-68b0a87a6506', '9002');
INSERT INTO rank_check_runs (id, config_id, project_id, status, keywords_total, keywords_checked, started_at, completed_at)
VALUES ('fixture-history-run', '08cbc9b1-82b4-4b5b-984a-0f7e57f8296d', '8814bf28-0081-48e6-8f07-a4774efe4d15', 'completed', 2, 2, '2026-11-19T10:00:00.000Z', '2026-11-19T10:05:00.000Z');
INSERT INTO rank_snapshots (run_id, project_id, config_id, tracking_keyword_id, keyword, device, position, ranking_status, url, provider, tracking_target_id, checked_at, checked_date)
VALUES
  ('fixture-history-run', '8814bf28-0081-48e6-8f07-a4774efe4d15', '08cbc9b1-82b4-4b5b-984a-0f7e57f8296d', '428239c7-eed4-4d30-82ea-c3133db4682f', 'إنشاء ملاعب كرة القدم', 'desktop', 6, 'RANKED', 'https://matchday.example/football', 'seranking', 'fixture-desktop', '2026-11-19T10:04:00.000Z', '2026-11-19'),
  ('fixture-history-run', '8814bf28-0081-48e6-8f07-a4774efe4d15', '08cbc9b1-82b4-4b5b-984a-0f7e57f8296d', '698b43a4-698a-4a57-ac8e-68b0a87a6506', 'صيانة الملاعب الرياضية', 'mobile', 12, 'RANKED', 'https://matchday.example/maintenance', 'seranking', 'fixture-mobile', '2026-11-19T10:04:00.000Z', '2026-11-19');
