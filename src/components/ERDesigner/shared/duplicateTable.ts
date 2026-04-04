import type { ErTable, ErColumn } from '../../../types';

type AddTableFn = (projectId: number, name: string, position: { x: number; y: number }) => Promise<ErTable>;
type AddColumnFn = (tableId: number, column: Partial<ErColumn>) => Promise<ErColumn>;

/**
 * 复制一张表（含所有列），目标位置偏移 (50, 50)。
 */
export async function duplicateTable(
  table: ErTable,
  srcCols: ErColumn[],
  addTable: AddTableFn,
  addColumn: AddColumnFn,
): Promise<ErTable> {
  const newTable = await addTable(table.project_id, `${table.name}_copy`, {
    x: table.position_x + 50,
    y: table.position_y + 50,
  });
  for (let i = 0; i < srcCols.length; i++) {
    const col = srcCols[i];
    await addColumn(newTable.id, {
      name: col.name,
      data_type: col.data_type,
      nullable: col.nullable,
      default_value: col.default_value,
      is_primary_key: col.is_primary_key,
      is_auto_increment: col.is_auto_increment,
      comment: col.comment,
      length: col.length,
      scale: col.scale,
      is_unique: col.is_unique,
      unsigned: col.unsigned,
      charset: col.charset,
      collation: col.collation,
      on_update: col.on_update,
      enum_values: col.enum_values,
      sort_order: i,
    });
  }
  return newTable;
}
