import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronLeft, ChevronRight, ChevronDown, RefreshCw, Plus, Minus,
  Undo, Redo, Upload, BarChart2, Download, Search, Filter,
  MoreVertical, Copy, Clipboard, Trash2, CopyPlus
} from 'lucide-react';

interface TableDataViewProps {
  tableName: string;
  dbName: string;
  showToast: (msg: string) => void;
}

export const TableDataView: React.FC<TableDataViewProps> = ({ tableName, dbName, showToast }) => {
  const { t } = useTranslation();
  const [contextMenu, setContextMenu] = useState<{x: number, y: number, rowIdx: number} | null>(null);

  const mockData = Array.from({ length: 30 }).map((_, i) => ({
    id: i + 1,
    company: ['Tech Supplies', 'Furniture Co', 'Clothing Inc', 'Book Publisher', 'Toy Maker'][i % 5],
    contactName: ['John Doe', 'Jane Smith', 'Bob Johnson', 'Alice Davis', 'Charlie Brown'][i % 5],
    contactTitle: ['Sales Manager', 'Account Manager', 'Customer Service', 'Publisher', 'General Manager'][i % 5],
    phone: `+1-555-${1000 + i}`
  }));

  const handleContextMenu = (e: React.MouseEvent, rowIdx: number) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, rowIdx });
  };

  const closeContextMenu = () => setContextMenu(null);

  return (
    <div className="flex-1 flex flex-col bg-[#1e1e1e] h-full relative" onClick={closeContextMenu}>
      {/* Toolbar */}
      <div className="h-10 flex items-center justify-between px-3 border-b border-[#2b2b2b] bg-[#1e1e1e] text-[#cccccc] text-xs">
        <div className="flex items-center space-x-3">
          <div className="flex items-center space-x-1">
            <button className="p-1 hover:bg-[#2b2b2b] rounded text-[#858585] hover:text-[#d4d4d4]" onClick={() => showToast(t('tableDataView.firstPage'))}>|&lt;</button>
            <button className="p-1 hover:bg-[#2b2b2b] rounded text-[#858585] hover:text-[#d4d4d4]" onClick={() => showToast(t('tableDataView.prevPage'))}>&lt;</button>
            <span className="px-2">1</span>
            <button className="p-1 hover:bg-[#2b2b2b] rounded text-[#858585] hover:text-[#d4d4d4]" onClick={() => showToast(t('tableDataView.nextPage'))}>&gt;</button>
            <button className="p-1 hover:bg-[#2b2b2b] rounded text-[#858585] hover:text-[#d4d4d4]" onClick={() => showToast(t('tableDataView.lastPage'))}>&gt;|</button>
          </div>

          <div className="flex items-center cursor-pointer hover:bg-[#2b2b2b] px-2 py-1 rounded">
            <span>1000</span>
            <ChevronDown size={14} className="ml-1 text-[#858585]" />
          </div>

          <span className="text-[#858585]">{t('tableDataView.total')} 30</span>

          <div className="w-[1px] h-4 bg-[#3c3c3c] mx-1"></div>

          <div className="flex items-center space-x-1 text-[#858585]">
            <button className="p-1.5 hover:bg-[#2b2b2b] hover:text-[#d4d4d4] rounded" title={t('tableDataView.refreshData')} onClick={() => showToast(t('tableDataView.refreshData'))}><RefreshCw size={14} /></button>
            <button className="p-1.5 hover:bg-[#2b2b2b] hover:text-[#d4d4d4] rounded" title={t('tableDataView.addRow')} onClick={() => showToast(t('tableDataView.addRow'))}><Plus size={14} /></button>
            <button className="p-1.5 hover:bg-[#2b2b2b] hover:text-[#d4d4d4] rounded" title={t('tableDataView.deleteRow')} onClick={() => showToast(t('tableDataView.deleteRow'))}><Minus size={14} /></button>
            <button className="p-1.5 hover:bg-[#2b2b2b] hover:text-[#d4d4d4] rounded" title={t('tableDataView.undo')} onClick={() => showToast(t('tableDataView.undo'))}><Undo size={14} /></button>
            <button className="p-1.5 hover:bg-[#2b2b2b] hover:text-[#d4d4d4] rounded" title={t('tableDataView.redo')} onClick={() => showToast(t('tableDataView.redo'))}><Redo size={14} /></button>
            <button className="p-1.5 hover:bg-[#2b2b2b] hover:text-[#d4d4d4] rounded" title={t('tableDataView.upload')} onClick={() => showToast(t('tableDataView.upload'))}><Upload size={14} /></button>
            <button className="p-1.5 hover:bg-[#2b2b2b] hover:text-[#d4d4d4] rounded" title={t('tableDataView.chart')} onClick={() => showToast(t('tableDataView.chart'))}><BarChart2 size={14} /></button>
          </div>
        </div>

        <div className="flex items-center">
          <div className="flex items-center cursor-pointer hover:bg-[#2b2b2b] px-2 py-1 rounded text-[#858585] hover:text-[#d4d4d4]">
            <span>{t('tableDataView.export')}</span>
            <ChevronDown size={14} className="ml-1" />
          </div>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="h-8 flex items-center px-3 border-b border-[#2b2b2b] bg-[#1e1e1e] text-xs">
        <div className="flex items-center text-[#858585] flex-1">
          <Filter size={14} className="mr-2" />
          <span className="mr-2">WHERE</span>
          <input type="text" className="bg-transparent border-none outline-none text-[#d4d4d4] flex-1" placeholder={t('tableDataView.enterCondition')} />
        </div>
        <div className="w-[1px] h-4 bg-[#3c3c3c] mx-3"></div>
        <div className="flex items-center text-[#858585] flex-1">
          <span className="mr-2">ORDER BY</span>
          <input type="text" className="bg-transparent border-none outline-none text-[#d4d4d4] flex-1" placeholder={t('tableDataView.enterOrder')} />
        </div>
      </div>

      {/* Search Bar */}
      <div className="h-8 flex items-center px-3 border-b border-[#2b2b2b] bg-[#1e1e1e] text-xs">
        <Search size={14} className="text-[#858585] mr-2" />
        <input type="text" className="bg-transparent border-none outline-none text-[#d4d4d4] flex-1" placeholder={t('tableDataView.searchResultData')} />
      </div>

      {/* Data Table */}
      <div className="flex-1 overflow-auto bg-[#1e1e1e]">
        <table className="w-full text-left border-collapse whitespace-nowrap text-[13px]">
          <thead className="sticky top-0 bg-[#252526] z-10 shadow-sm">
            <tr>
              <th className="w-12 px-2 py-1.5 text-center border-b border-r border-[#2b2b2b] text-[#858585] font-normal">
                #
              </th>
              {['SupplierID', 'Company', 'ContactName', 'ContactTitle', 'Phone'].map(h => (
                <th key={h} className="px-3 py-1.5 border-b border-r border-[#2b2b2b] text-[#d4d4d4] font-normal hover:bg-[#2a2d2e] cursor-pointer">
                  <div className="flex items-center justify-between">
                    <span>{h}</span>
                    <Filter size={12} className="text-[#858585]" />
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {mockData.map((row, i) => (
              <tr
                key={i}
                className="hover:bg-[#2a2d2e] border-b border-[#2b2b2b]"
                onContextMenu={(e) => handleContextMenu(e, i)}
              >
                <td className="px-2 py-1.5 text-center border-r border-[#2b2b2b] text-[#858585] bg-[#252526]">{i + 1}</td>
                <td className="px-3 py-1.5 border-r border-[#2b2b2b] text-[#d4d4d4]">{row.id}</td>
                <td className="px-3 py-1.5 border-r border-[#2b2b2b] text-[#d4d4d4]">{row.company}</td>
                <td className="px-3 py-1.5 border-r border-[#2b2b2b] text-[#d4d4d4]">{row.contactName}</td>
                <td className="px-3 py-1.5 border-r border-[#2b2b2b] text-[#d4d4d4]">{row.contactTitle}</td>
                <td className="px-3 py-1.5 border-r border-[#2b2b2b] text-[#d4d4d4]">{row.phone}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Status Bar */}
      <div className="h-8 flex items-center px-3 border-t border-[#2b2b2b] bg-[#181818] text-[#858585] text-xs flex-shrink-0">
        <div className="flex items-center space-x-4">
          <span>INIT</span>
          <span className="text-[#d4d4d4]">{t('tableDataView.resultPrefix')}{t('tableDataView.executionSuccessful')}</span>
          <span className="text-[#d4d4d4]">{t('tableDataView.timeConsumedPrefix')}37ms.</span>
          <span className="text-[#d4d4d4]">{t('tableDataView.searchResultPrefix')}30 {t('tableDataView.row')}</span>
        </div>
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          className="fixed bg-[#252526] border border-[#3c3c3c] rounded shadow-xl z-50 py-1 text-[13px] text-[#d4d4d4] w-48"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <div className="px-3 py-1.5 hover:bg-[#37373d] cursor-pointer flex items-center" onClick={() => { showToast(t('tableDataView.viewOrModifyData')); closeContextMenu(); }}>
            <Search size={14} className="mr-2 text-[#858585]" /> {t('tableDataView.viewOrModifyData')}
          </div>
          <div className="px-3 py-1.5 hover:bg-[#37373d] cursor-pointer flex items-center" onClick={() => { showToast(t('tableDataView.copy')); closeContextMenu(); }}>
            <Copy size={14} className="mr-2 text-[#858585]" /> {t('tableDataView.copy')}
          </div>
          <div className="px-3 py-1.5 hover:bg-[#37373d] cursor-pointer flex items-center" onClick={() => { showToast(t('tableDataView.paste')); closeContextMenu(); }}>
            <Clipboard size={14} className="mr-2 text-[#858585]" /> {t('tableDataView.paste')}
          </div>
          <div className="my-1 border-t border-[#3c3c3c]"></div>
          <div className="px-3 py-1.5 hover:bg-[#37373d] cursor-pointer flex items-center pl-9" onClick={() => { showToast(t('tableDataView.setAsNull')); closeContextMenu(); }}>
            {t('tableDataView.setAsNull')}
          </div>
          <div className="px-3 py-1.5 hover:bg-[#37373d] cursor-pointer flex items-center pl-9" onClick={() => { showToast(t('tableDataView.cloneRow')); closeContextMenu(); }}>
            {t('tableDataView.cloneRow')}
          </div>
          <div className="px-3 py-1.5 hover:bg-[#37373d] cursor-pointer flex items-center" onClick={() => { showToast(t('tableDataView.deleteRowMenuItem')); closeContextMenu(); }}>
            <Trash2 size={14} className="mr-2 text-[#858585]" /> {t('tableDataView.deleteRowMenuItem')}
          </div>
          <div className="my-1 border-t border-[#3c3c3c]"></div>
          <div className="px-3 py-1.5 hover:bg-[#37373d] cursor-pointer flex items-center justify-between" onClick={() => { showToast(t('tableDataView.copyRowAction')); closeContextMenu(); }}>
            <div className="flex items-center">
              <CopyPlus size={14} className="mr-2 text-[#858585]" /> {t('tableDataView.copyRowAction')}
            </div>
            <ChevronRight size={14} className="text-[#858585]" />
          </div>
        </div>
      )}
    </div>
  );
};
