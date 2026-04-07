export function createDefaultColumn(sortOrder: number) {
  return {
    name: `column_${sortOrder + 1}`,
    data_type: 'VARCHAR',
    nullable: true,
    default_value: null,
    is_primary_key: false,
    is_auto_increment: false,
    comment: null,
    length: null,
    scale: null,
    is_unique: false,
    unsigned: false,
    charset: null,
    collation: null,
    on_update: null,
    enum_values: null,
    sort_order: sortOrder,
  };
}
