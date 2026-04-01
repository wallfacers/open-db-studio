import type { NodeTypes, EdgeTypes } from '@xyflow/react';
import { TableNodeComponent, MetricNodeComponent, AliasNodeComponent, LinkNodeComponent, RelationEdge, SelfLoopEdge } from './GraphNodeComponents';

export const nodeTypes: NodeTypes = {
  table: TableNodeComponent,
  metric: MetricNodeComponent,
  alias: AliasNodeComponent,
  link: LinkNodeComponent,
};

export const edgeTypes: EdgeTypes = {
  relation: RelationEdge,
  selfLoop: SelfLoopEdge,
};
