export const DEFAULT_LIMITS = {
  max_files: 50,
  max_bytes_per_file: 128_000,
  max_total_bytes: 750_000,
  max_search_query_length: 200,
  max_search_results: 100,
  max_tree_entries: 2_000,
  max_task_inventory_files: 5_000,
  max_task_inventory_tree_pages: 20,
  max_task_inventory_file_bytes: 128_000,
  max_project_brief_doc_bytes: 32_000,
  max_decision_log_source_bytes: 32_000,
  max_decision_log_sources: 20,
  max_change_plan_files: 30,
  max_change_plan_tree_pages: 5,
  max_depth: 8,
  max_diff_bytes: 256_000
} as const;
