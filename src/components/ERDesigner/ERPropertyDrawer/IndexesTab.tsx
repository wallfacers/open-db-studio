import { useErDesignerStore } from '@/store/erDesignerStore';
import IndexEditor from '../shared/IndexEditor';

interface IndexesTabProps {
  tableId: number;
  tableName: string;
}

export default function IndexesTab({ tableId, tableName }: IndexesTabProps) {
  const { indexes, columns, addIndex, updateIndex, deleteIndex } = useErDesignerStore();
  return (
    <div className="p-2">
      <IndexEditor
        indexes={indexes[tableId] ?? []}
        columns={columns[tableId] ?? []}
        tableId={tableId}
        tableName={tableName}
        onAdd={addIndex}
        onUpdate={updateIndex}
        onDelete={deleteIndex}
      />
    </div>
  );
}
