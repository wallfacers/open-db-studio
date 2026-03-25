import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useConnectionStore } from '../../../store/connectionStore';
import { useErDesignerStore } from '../../../store/erDesignerStore';
import { BaseModal } from '../../common/BaseModal';
import { DropdownSelect } from '../../common/DropdownSelect';

export interface BindConnectionDialogProps {
  visible: boolean;
  projectId: number;
  onClose: () => void;
  onBound: () => void;
}

export const BindConnectionDialog: React.FC<BindConnectionDialogProps> = ({
  visible,
  projectId,
  onClose,
  onBound,
}) => {
  const { connections, loadConnections } = useConnectionStore();
  const bindConnection = useErDesignerStore((s) => s.bindConnection);

  const [selectedConnectionId, setSelectedConnectionId] = useState<number | null>(null);
  const [selectedDatabase, setSelectedDatabase] = useState('');
  const [selectedSchema, setSelectedSchema] = useState('');
  const [databaseOptions, setDatabaseOptions] = useState<Array<{ value: string; label: string }>>([]);
  const [schemaOptions, setSchemaOptions] = useState<Array<{ value: string; label: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [loadingDatabases, setLoadingDatabases] = useState(false);
  const [loadingSchemas, setLoadingSchemas] = useState(false);
  const [error, setError] = useState('');

  // 加载连接列表
  useEffect(() => {
    if (visible && connections.length === 0) {
      loadConnections();
    }
  }, [visible, connections.length, loadConnections]);

  // 选择连接后加载数据库列表
  useEffect(() => {
    const loadDatabases = async () => {
      if (selectedConnectionId === null) {
        setDatabaseOptions([]);
        setSelectedDatabase('');
        return;
      }
      setLoadingDatabases(true);
      setError('');
      try {
        const dbs = await invoke<string[]>('list_databases', { connectionId: selectedConnectionId });
        setDatabaseOptions(dbs.map(db => ({ value: db, label: db })));
      } catch (e) {
        setError('加载数据库列表失败: ' + String(e));
        setDatabaseOptions([]);
      } finally {
        setLoadingDatabases(false);
      }
    };
    loadDatabases();
  }, [selectedConnectionId]);

  // 选择数据库后（仅 PostgreSQL）加载 Schema 列表
  useEffect(() => {
    const loadSchemas = async () => {
      const conn = connections.find(c => c.id === selectedConnectionId);
      if (!conn || conn.driver !== 'postgresql' || !selectedDatabase) {
        setSchemaOptions([]);
        setSelectedSchema('');
        return;
      }
      setLoadingSchemas(true);
      setError('');
      try {
        const schemas = await invoke<string[]>('list_schemas', {
          connectionId: selectedConnectionId,
          database: selectedDatabase,
        });
        setSchemaOptions(schemas.map(s => ({ value: s, label: s })));
        // 默认选择 public
        if (schemas.includes('public')) {
          setSelectedSchema('public');
        }
      } catch (e) {
        setError('加载 Schema 列表失败: ' + String(e));
        setSchemaOptions([]);
      } finally {
        setLoadingSchemas(false);
      }
    };
    loadSchemas();
  }, [selectedConnectionId, selectedDatabase, connections]);

  const handleBind = async () => {
    if (!selectedConnectionId || !selectedDatabase) {
      setError('请选择连接和数据库');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await bindConnection(
        projectId,
        selectedConnectionId,
        selectedDatabase,
        selectedSchema || undefined,
      );
      onBound();
      onClose();
    } catch (e) {
      setError('绑定连接失败: ' + String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setSelectedConnectionId(null);
    setSelectedDatabase('');
    setSelectedSchema('');
    setDatabaseOptions([]);
    setSchemaOptions([]);
    setError('');
    onClose();
  };

  const conn = connections.find(c => c.id === selectedConnectionId);
  const showSchema = conn?.driver === 'postgresql';

  return (
    <BaseModal
      title="绑定数据库连接"
      onClose={handleClose}
      width={480}
      footerButtons={[
        {
          label: '取消',
          onClick: handleClose,
          variant: 'secondary',
        },
        {
          label: '绑定',
          onClick: handleBind,
          variant: 'primary',
          loading,
          disabled: !selectedConnectionId || !selectedDatabase || loadingDatabases || loadingSchemas,
        },
      ]}
      footerHint={error || undefined}
    >
      <div className="flex flex-col gap-4">
        {/* 连接选择 */}
        <div>
          <label className="block text-xs text-[#7a9bb8] mb-1">连接</label>
          <DropdownSelect
            value={selectedConnectionId?.toString() || ''}
            options={connections.map(c => ({ value: c.id.toString(), label: c.name }))}
            onChange={(val) => setSelectedConnectionId(val ? Number(val) : null)}
            className="w-full"
            placeholder="请选择连接"
          />
        </div>

        {/* 数据库选择 */}
        <div>
          <label className="block text-xs text-[#7a9bb8] mb-1">数据库</label>
          {loadingDatabases ? (
            <div className="text-xs text-[#7a9bb8]">加载中...</div>
          ) : (
            <DropdownSelect
              value={selectedDatabase}
              options={databaseOptions}
              onChange={setSelectedDatabase}
              className="w-full"
              placeholder="请选择数据库"
            />
          )}
        </div>

        {/* Schema 选择（仅 PostgreSQL） */}
        {showSchema && (
          <div>
            <label className="block text-xs text-[#7a9bb8] mb-1">Schema</label>
            {loadingSchemas ? (
              <div className="text-xs text-[#7a9bb8]">加载中...</div>
            ) : (
              <DropdownSelect
                value={selectedSchema}
                options={schemaOptions}
                onChange={setSelectedSchema}
                className="w-full"
                placeholder="请选择 Schema"
              />
            )}
          </div>
        )}

        {/* 提示信息 */}
        {conn && !showSchema && (
          <div className="text-xs text-[#7a9bb8]">
            当前数据库类型: {conn.driver}
          </div>
        )}
      </div>
    </BaseModal>
  );
};
