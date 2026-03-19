import type { NodeTypes } from '@xyflow/react';
import { TableNodeComponent } from './GraphNodeComponents';
import { MetricNodeComponent } from './GraphNodeComponents';
import { AliasNodeComponent } from './GraphNodeComponents';

export const nodeTypes: NodeTypes = {
  table: TableNodeComponent,
  metric: MetricNodeComponent,
  alias: AliasNodeComponent,
};
