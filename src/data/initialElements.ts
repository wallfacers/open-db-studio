import { Node, Edge } from '@xyflow/react';
import { TableNodeData } from '../components/TableNode';

const edgeOptions = {
  type: 'bezier',
  animated: false,
  style: { stroke: '#a1a1aa', strokeWidth: 2 },
};

export const initialNodes: Node<TableNodeData>[] = [
  {
    id: 'suppliers',
    type: 'table',
    position: { x: 50, y: 50 },
    data: {
      tableName: 'Suppliers',
      columns: [
        { name: 'SupplierID', type: 'INT', isPrimary: true },
        { name: 'CompanyName', type: 'VARCHAR' },
        { name: 'ContactName', type: 'VARCHAR' },
        { name: 'ContactTitle', type: 'VARCHAR' },
        { name: 'Phone', type: 'VARCHAR' },
      ],
    },
  },
  {
    id: 'categories',
    type: 'table',
    position: { x: 50, y: 350 },
    data: {
      tableName: 'Categories',
      columns: [
        { name: 'CategoryID', type: 'INT', isPrimary: true },
        { name: 'CategoryName', type: 'VARCHAR' },
      ],
    },
  },
  {
    id: 'customers',
    type: 'table',
    position: { x: 50, y: 550 },
    data: {
      tableName: 'Customers',
      columns: [
        { name: 'CustomerID', type: 'INT', isPrimary: true },
        { name: 'CompanyName', type: 'VARCHAR' },
      ],
    },
  },
  {
    id: 'purchase_orders',
    type: 'table',
    position: { x: 400, y: 20 },
    data: {
      tableName: 'PurchaseOrders',
      columns: [
        { name: 'OrderID', type: 'INT', isPrimary: true },
        { name: 'SupplierID', type: 'INT', isForeign: true },
        { name: 'OrderDate', type: 'DATETIME' },
        { name: 'RequiredDate', type: 'DATETIME' },
        { name: 'Status', type: 'VARCHAR' },
      ],
    },
  },
  {
    id: 'products',
    type: 'table',
    position: { x: 400, y: 300 },
    data: {
      tableName: 'Products',
      columns: [
        { name: 'ProductID', type: 'INT', isPrimary: true },
        { name: 'ProductName', type: 'VARCHAR' },
        { name: 'CategoryID', type: 'INT', isForeign: true },
        { name: 'UnitPrice', type: 'DECIMAL' },
        { name: 'inventory', type: 'INT' },
      ],
    },
  },
  {
    id: 'sales_orders',
    type: 'table',
    position: { x: 400, y: 550 },
    data: {
      tableName: 'SalesOrders',
      columns: [
        { name: 'OrderID', type: 'INT', isPrimary: true },
        { name: 'CustomerID', type: 'INT', isForeign: true },
        { name: 'OrderDate', type: 'DATETIME' },
      ],
    },
  },
  {
    id: 'purchase_order_details',
    type: 'table',
    position: { x: 750, y: 100 },
    data: {
      tableName: 'PurchaseOrderDetails',
      columns: [
        { name: 'OrderDetailID', type: 'INT', isPrimary: true },
        { name: 'OrderID', type: 'INT', isForeign: true },
        { name: 'ProductID', type: 'INT', isForeign: true },
        { name: 'Quantity', type: 'INT' },
        { name: 'UnitPrice', type: 'DECIMAL' },
      ],
    },
  },
  {
    id: 'sales_order_details',
    type: 'table',
    position: { x: 750, y: 400 },
    data: {
      tableName: 'SalesOrderDetails',
      columns: [
        { name: 'OrderDetailID', type: 'INT', isPrimary: true },
        { name: 'OrderID', type: 'INT', isForeign: true },
        { name: 'ProductID', type: 'INT', isForeign: true },
        { name: 'sales_quantity', type: 'INT' },
        { name: 'UnitPrice', type: 'DECIMAL' },
      ],
    },
  },
];

export const initialEdges: Edge[] = [
  {
    id: 'e-sup-po',
    source: 'suppliers',
    sourceHandle: 'SupplierID-source',
    target: 'purchase_orders',
    targetHandle: 'SupplierID-target',
    ...edgeOptions,
  },
  {
    id: 'e-cat-prod',
    source: 'categories',
    sourceHandle: 'CategoryID-source',
    target: 'products',
    targetHandle: 'CategoryID-target',
    ...edgeOptions,
  },
  {
    id: 'e-cust-so',
    source: 'customers',
    sourceHandle: 'CustomerID-source',
    target: 'sales_orders',
    targetHandle: 'CustomerID-target',
    ...edgeOptions,
  },
  {
    id: 'e-po-pod',
    source: 'purchase_orders',
    sourceHandle: 'OrderID-source',
    target: 'purchase_order_details',
    targetHandle: 'OrderID-target',
    ...edgeOptions,
  },
  {
    id: 'e-prod-pod',
    source: 'products',
    sourceHandle: 'ProductID-source',
    target: 'purchase_order_details',
    targetHandle: 'ProductID-target',
    ...edgeOptions,
  },
  {
    id: 'e-prod-sod',
    source: 'products',
    sourceHandle: 'ProductID-source',
    target: 'sales_order_details',
    targetHandle: 'ProductID-target',
    ...edgeOptions,
  },
  {
    id: 'e-so-sod',
    source: 'sales_orders',
    sourceHandle: 'OrderID-source',
    target: 'sales_order_details',
    targetHandle: 'OrderID-target',
    ...edgeOptions,
  },
];
