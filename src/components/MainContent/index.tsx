import React from 'react';
import Editor from 'react-simple-code-editor';
import Prism from 'prismjs';
import 'prismjs/components/prism-sql';
import {
  FileCode2, X, Play, Square, Save, FileEdit, Settings, DatabaseZap, ChevronDown, Folder,
  RefreshCw, Download, Search, Filter, TableProperties, Plus
} from 'lucide-react';
import { TabData } from '../../App';
import { TableDataView } from './TableDataView';
import ERDiagram from '../ERDiagram';

interface MainContentProps {
  tabs: TabData[];
  activeTab: string;
  setActiveTab: (tabId: string) => void;
  closeTab: (e: React.MouseEvent, tabId: string) => void;
  sqlContent: string;
  setSqlContent: (content: string) => void;
  handleExecute: () => void;
  isExecuting: boolean;
  handleFormat: () => void;
  handleClear: () => void;
  showToast: (msg: string) => void;
  isDbMenuOpen: boolean;
  setIsDbMenuOpen: (isOpen: boolean) => void;
  isTableMenuOpen: boolean;
  setIsTableMenuOpen: (isOpen: boolean) => void;
  resultsHeight: number;
  handleResultsResize: (e: React.MouseEvent) => void;
  resultsTab: string;
  setResultsTab: (tab: string) => void;
  isPageSizeMenuOpen: boolean;
  setIsPageSizeMenuOpen: (isOpen: boolean) => void;
  isExportMenuOpen: boolean;
  setIsExportMenuOpen: (isOpen: boolean) => void;
  tableData: any[];
  executionTime: number;
}

export const MainContent: React.FC<MainContentProps> = ({
  tabs, activeTab, setActiveTab, closeTab,
  sqlContent, setSqlContent, handleExecute, isExecuting, handleFormat, handleClear, showToast,
  isDbMenuOpen, setIsDbMenuOpen, isTableMenuOpen, setIsTableMenuOpen,
  resultsHeight, handleResultsResize, resultsTab, setResultsTab,
  isPageSizeMenuOpen, setIsPageSizeMenuOpen, isExportMenuOpen, setIsExportMenuOpen,
  tableData, executionTime
}) => {
  const activeTabObj = tabs.find(t => t.id === activeTab);

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-[#1e1e1e]">
      {/* Tabs */}
      <div className="flex items-center bg-[#181818] border-b border-[#2b2b2b] overflow-x-auto no-scrollbar">
        {tabs.map(tab => (
          <div 
            key={tab.id}
            className={`flex items-center px-4 py-2 border-r border-[#2b2b2b] cursor-pointer min-w-[120px] max-w-[200px] group ${activeTab === tab.id ? 'bg-[#1e1e1e] text-[#3794ff] border-t-2 border-t-[#3794ff]' : 'bg-[#2d2d2d] text-[#858585] border-t-2 border-t-transparent hover:bg-[#252526]'}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.type === 'query' ? (
              <FileCode2 size={14} className={`mr-2 flex-shrink-0 ${activeTab === tab.id ? 'text-[#3794ff]' : 'text-[#858585]'}`} />
            ) : tab.type === 'er_diagram' ? (
              <DatabaseZap size={14} className={`mr-2 flex-shrink-0 ${activeTab === tab.id ? 'text-[#3794ff]' : 'text-[#858585]'}`} />
            ) : (
              <TableProperties size={14} className={`mr-2 flex-shrink-0 ${activeTab === tab.id ? 'text-[#3794ff]' : 'text-[#858585]'}`} />
            )}
            <span className="truncate flex-1 text-xs">{tab.title}</span>
            <div 
              className={`ml-2 p-0.5 rounded-sm hover:bg-[#3c3c3c] ${activeTab === tab.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
              onClick={(e) => closeTab(e, tab.id)}
            >
              <X size={12} />
            </div>
          </div>
        ))}
      </div>

      {activeTabObj ? (
        activeTabObj.type === 'er_diagram' ? (
          <div className="flex-1 w-full h-full relative">
            <ERDiagram />
          </div>
        ) : activeTabObj.type === 'table' ? (
          <TableDataView 
            tableName={activeTabObj.title} 
            dbName={activeTabObj.db || 'demo'} 
            showToast={showToast} 
          />
        ) : (
          <>
            {/* Toolbar */}
            <div className="h-10 flex items-center justify-between px-4 border-b border-[#2b2b2b] bg-[#1e1e1e]">
            <div className="flex items-center space-x-2">
              <button 
                className={`flex items-center px-3 py-1.5 rounded text-xs font-medium transition-colors ${isExecuting ? 'bg-[#2b2b2b] text-[#858585] cursor-not-allowed' : 'bg-[#3794ff] hover:bg-[#2b7cdb] text-white'}`}
                onClick={handleExecute}
                disabled={isExecuting}
              >
                {isExecuting ? <Square size={14} className="mr-1.5" /> : <Play size={14} className="mr-1.5" />}
                {isExecuting ? '执行中...' : '执行'}
              </button>
              <div className="w-[1px] h-4 bg-[#3c3c3c] mx-1"></div>
              <button className="p-1.5 text-[#858585] hover:text-[#d4d4d4] hover:bg-[#2b2b2b] rounded transition-colors" title="Save" onClick={() => showToast('已保存 SQL 文件')}>
                <Save size={16} />
              </button>
              <button className="p-1.5 text-[#858585] hover:text-[#d4d4d4] hover:bg-[#2b2b2b] rounded transition-colors" title="Format SQL" onClick={handleFormat}>
                <FileEdit size={16} />
              </button>
              <button className="p-1.5 text-[#858585] hover:text-[#d4d4d4] hover:bg-[#2b2b2b] rounded transition-colors" title="Clear" onClick={handleClear}>
                <X size={16} />
              </button>
              <button className="p-1.5 text-[#858585] hover:text-[#d4d4d4] hover:bg-[#2b2b2b] rounded transition-colors" title="Settings" onClick={() => showToast('打开编辑器设置')}>
                <Settings size={16} />
              </button>
            </div>
            
            <div className="flex items-center space-x-3">
              <div className="relative">
                <div 
                  className="flex items-center text-xs text-[#d4d4d4] cursor-pointer hover:bg-[#2b2b2b] px-2 py-1 rounded"
                  onClick={(e) => { e.stopPropagation(); setIsDbMenuOpen(!isDbMenuOpen); setIsTableMenuOpen(false); }}
                >
                  <DatabaseZap size={14} className="mr-1.5 text-[#3794ff]" />
                  <span>demo</span>
                  <ChevronDown size={14} className="ml-1 text-[#858585]" />
                </div>
                {isDbMenuOpen && (
                  <div className="absolute right-0 top-full mt-1 w-48 bg-[#252526] border border-[#3c3c3c] rounded shadow-lg z-50 py-1">
                    <div className="px-3 py-1.5 hover:bg-[#37373d] cursor-pointer text-[#d4d4d4] flex items-center" onClick={() => { setIsDbMenuOpen(false); showToast('已切换到数据库: demo'); }}><DatabaseZap size={14} className="mr-2 text-[#3794ff]"/> demo</div>
                    <div className="px-3 py-1.5 hover:bg-[#37373d] cursor-pointer text-[#d4d4d4] flex items-center" onClick={() => { setIsDbMenuOpen(false); showToast('已切换到数据库: MySQL_demo'); }}><DatabaseZap size={14} className="mr-2 text-[#858585]"/> MySQL_demo</div>
                    <div className="px-3 py-1.5 hover:bg-[#37373d] cursor-pointer text-[#d4d4d4] flex items-center" onClick={() => { setIsDbMenuOpen(false); showToast('已切换到数据库: SQLServer'); }}><DatabaseZap size={14} className="mr-2 text-[#858585]"/> SQLServer</div>
                  </div>
                )}
              </div>
              <div className="w-[1px] h-4 bg-[#3c3c3c]"></div>
              <div className="relative">
                <div 
                  className="flex items-center text-xs text-[#d4d4d4] cursor-pointer hover:bg-[#2b2b2b] px-2 py-1 rounded"
                  onClick={(e) => { e.stopPropagation(); setIsTableMenuOpen(!isTableMenuOpen); setIsDbMenuOpen(false); }}
                >
                  <Folder size={14} className="mr-1.5 text-[#dcdcaa]" />
                  <span>birth_analysis</span>
                  <ChevronDown size={14} className="ml-1 text-[#858585]" />
                </div>
                {isTableMenuOpen && (
                  <div className="absolute right-0 top-full mt-1 w-48 bg-[#252526] border border-[#3c3c3c] rounded shadow-lg z-50 py-1">
                    <div className="px-3 py-1.5 hover:bg-[#37373d] cursor-pointer text-[#d4d4d4] flex items-center" onClick={() => { setIsTableMenuOpen(false); showToast('已切换到表: birth_analysis'); }}><Folder size={14} className="mr-2 text-[#dcdcaa]"/> birth_analysis</div>
                    <div className="px-3 py-1.5 hover:bg-[#37373d] cursor-pointer text-[#d4d4d4] flex items-center" onClick={() => { setIsTableMenuOpen(false); showToast('已切换到表: ERP'); }}><Folder size={14} className="mr-2 text-[#858585]"/> ERP</div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Editor Content */}
          <div className="flex-1 overflow-auto relative bg-[#1e1e1e]">
            <Editor
              value={sqlContent}
              onValueChange={setSqlContent}
              highlight={code => Prism.highlight(code, Prism.languages.sql, 'sql')}
              padding={16}
              style={{
                fontFamily: '"JetBrains Mono", "Fira Code", monospace',
                fontSize: 13,
                minHeight: '100%',
                color: '#d4d4d4'
              }}
              className="editor-container"
            />
          </div>

          {/* Results Resizer */}
          <div 
            className="h-1 cursor-row-resize hover:bg-[#3794ff] bg-[#2b2b2b] transition-colors z-10"
            onMouseDown={handleResultsResize}
          ></div>

          {/* Results Area */}
          <div className="flex flex-col bg-[#1e1e1e] flex-shrink-0" style={{ height: resultsHeight }}>
            {/* Results Tabs */}
            <div className="flex items-center bg-[#181818] border-b border-[#2b2b2b]">
              <div 
                className={`px-4 py-2 text-xs cursor-pointer border-t-2 ${resultsTab === 'overview' ? 'border-t-[#3794ff] text-[#d4d4d4] bg-[#1e1e1e]' : 'border-t-transparent text-[#858585] hover:text-[#d4d4d4]'}`}
                onClick={() => setResultsTab('overview')}
              >
                执行概览
              </div>
              <div 
                className={`px-4 py-2 text-xs cursor-pointer border-t-2 ${resultsTab === 'result1' ? 'border-t-[#3794ff] text-[#d4d4d4] bg-[#1e1e1e]' : 'border-t-transparent text-[#858585] hover:text-[#d4d4d4]'}`}
                onClick={() => setResultsTab('result1')}
              >
                结果集 1
              </div>
            </div>

            {resultsTab === 'result1' ? (
              <>
                {/* Results Toolbar */}
                <div className="h-9 flex items-center justify-between px-3 border-b border-[#2b2b2b] bg-[#1e1e1e]">
                  <div className="flex items-center space-x-2 text-xs text-[#858585]">
                    <div className="flex items-center space-x-1">
                      <button className="p-1 hover:bg-[#2b2b2b] hover:text-[#d4d4d4] rounded disabled:opacity-50" onClick={() => showToast('上一页')}>&lt;</button>
                      <span className="px-2">1</span>
                      <button className="p-1 hover:bg-[#2b2b2b] hover:text-[#d4d4d4] rounded" onClick={() => showToast('下一页')}>&gt;</button>
                    </div>
                    <div className="w-[1px] h-3 bg-[#3c3c3c] mx-1"></div>
                    <div className="relative">
                      <div 
                        className="flex items-center cursor-pointer hover:bg-[#2b2b2b] px-2 py-1 rounded"
                        onClick={(e) => { e.stopPropagation(); setIsPageSizeMenuOpen(!isPageSizeMenuOpen); }}
                      >
                        <span>200 条/页</span>
                        <ChevronDown size={12} className="ml-1" />
                      </div>
                      {isPageSizeMenuOpen && (
                        <div className="absolute left-0 top-full mt-1 w-24 bg-[#252526] border border-[#3c3c3c] rounded shadow-lg z-50 py-1">
                          {[50, 100, 200, 500].map(size => (
                            <div 
                              key={size} 
                              className="px-3 py-1 hover:bg-[#37373d] cursor-pointer text-[#d4d4d4]"
                              onClick={() => { setIsPageSizeMenuOpen(false); showToast(`已切换为 ${size} 条/页`); }}
                            >
                              {size} 条/页
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center space-x-2 text-[#858585]">
                    <button className="p-1.5 hover:bg-[#2b2b2b] hover:text-[#d4d4d4] rounded transition-colors" title="Refresh" onClick={() => showToast('刷新结果集')}>
                      <RefreshCw size={14} />
                    </button>
                    <div className="relative">
                      <div 
                        className="flex items-center cursor-pointer hover:bg-[#2b2b2b] hover:text-[#d4d4d4] px-2 py-1 rounded transition-colors"
                        onClick={(e) => { e.stopPropagation(); setIsExportMenuOpen(!isExportMenuOpen); }}
                      >
                        <Download size={14} className="mr-1" />
                        <span>导出</span>
                        <ChevronDown size={12} className="ml-0.5" />
                      </div>
                      {isExportMenuOpen && (
                        <div className="absolute right-0 top-full mt-1 w-32 bg-[#252526] border border-[#3c3c3c] rounded shadow-lg z-50 py-1">
                          <div className="px-3 py-1.5 hover:bg-[#37373d] cursor-pointer text-[#d4d4d4]" onClick={() => { setIsExportMenuOpen(false); showToast('已导出为 CSV'); }}>导出为 CSV</div>
                          <div className="px-3 py-1.5 hover:bg-[#37373d] cursor-pointer text-[#d4d4d4]" onClick={() => { setIsExportMenuOpen(false); showToast('已导出为 Excel'); }}>导出为 Excel</div>
                          <div className="px-3 py-1.5 hover:bg-[#37373d] cursor-pointer text-[#d4d4d4]" onClick={() => { setIsExportMenuOpen(false); showToast('已导出为 SQL Insert'); }}>导出为 SQL Insert</div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Results Table */}
                <div className="flex-1 overflow-auto">
                  <table className="w-full text-left border-collapse whitespace-nowrap text-xs">
                    <thead className="sticky top-0 bg-[#1e1e1e] z-10">
                      <tr>
                        <th className="w-10 px-2 py-1.5 text-center border-b border-r border-[#2b2b2b] text-[#858585] font-normal bg-[#252526]">
                          <Search size={12} className="mx-auto" />
                        </th>
                        {['analysis_date', 'time_period', 'birth_rate', 'growth_rate', 'gender_ratio'].map(h => (
                          <th key={h} className="px-3 py-1.5 border-b border-r border-[#2b2b2b] text-[#d4d4d4] font-normal bg-[#252526]">
                            <div className="flex items-center justify-between">
                              <span>{h}</span>
                              <div className="flex flex-col ml-2 text-[#858585]">
                                <Filter size={10} />
                              </div>
                            </div>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {tableData.map((row, i) => (
                        <tr key={i} className="hover:bg-[#2a2d2e]">
                          <td className="px-2 py-1.5 text-center border-b border-r border-[#2b2b2b] text-[#858585]">{i + 1}</td>
                          {row.map((cell: any, j: number) => (
                            <td key={j} className="px-3 py-1.5 border-b border-r border-[#2b2b2b] text-[#d4d4d4]">{cell}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Status Bar */}
                <div className="h-7 flex items-center justify-between px-3 border-t border-[#2b2b2b] bg-[#181818] text-[#858585] text-xs">
                  <div className="flex items-center space-x-4">
                    <span>INIT</span>
                    <span className="text-[#d4d4d4]">【结果】执行成功。</span>
                    <span className="text-[#d4d4d4]">【耗时】{executionTime}ms.</span>
                    <span className="text-[#d4d4d4]">【查询行数】12 行.</span>
                  </div>
                  <div className="flex items-center space-x-4">
                    <span className="cursor-pointer hover:text-[#d4d4d4]" onClick={() => showToast('导出 ERP_demo 成功')}>Export ERP_demo</span>
                    <span className="cursor-pointer hover:text-[#d4d4d4]" onClick={() => showToast('加载全部数据')}>显示全部</span>
                  </div>
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-[#858585]">
                <div className="text-center">
                  <p>执行概览信息</p>
                </div>
              </div>
            )}
          </div>
        </>
        )
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center text-[#858585] bg-[#1e1e1e]">
          <DatabaseZap size={64} className="mb-4 opacity-20" />
          <p className="text-lg">No active editor</p>
          <p className="text-sm mt-2 opacity-60">Select a table or query to view</p>
        </div>
      )}
    </div>
  );
};
