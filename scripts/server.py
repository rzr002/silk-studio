#!/usr/bin/env python3
"""Loopback-only static workbench and optional stateless native reference route."""
import argparse
import hashlib
import importlib.util
import importlib.metadata
import json
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading

PROJECT=Path(__file__).resolve().parents[1]
MAX_REQUEST_BYTES=16*1024*1024

def load_reference_solver():
    path=Path(__file__).with_name('ipc-cloth.py')
    if not path.exists(): return None, '本地参考求解器尚未安装'
    try:
        source_hash=hashlib.sha256(path.read_bytes()).hexdigest()
        spec=importlib.util.spec_from_file_location('silk_ipc_cloth',path)
        module=importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        if hashlib.sha256(path.read_bytes()).hexdigest()!=source_hash:
            raise ImportError('求解器源码在载入时改变，请重新启动服务')
        module.solve_step.__silk_metadata__={'solverSourceHash':source_hash,'ipctkVersion':importlib.metadata.version('ipctk'),'numpyVersion':importlib.metadata.version('numpy'),'scipyVersion':importlib.metadata.version('scipy')}
        return module.solve_step, None
    except (ImportError,AttributeError) as error:
        return None, f'本地参考依赖不可用：{error}'

def identity(payload):
    if not isinstance(payload,dict) or type(payload.get('version')) is not int or payload.get('version')!=1:
        raise ValueError('参考计算协议 version 必须为 1')
    fields={key:payload.get(key) for key in ['version','epoch','requestId','designRevision','baseStateId']}
    for key in ['epoch','requestId','designRevision','baseStateId']:
        if type(fields[key]) is not int or fields[key] < (1 if key=='requestId' else 0):
            raise ValueError(f'参考计算身份 {key} 无效')
    if not all(isinstance(payload.get(key),dict) for key in ['snapshot','context','step']):
        raise ValueError('参考计算缺少 snapshot/context/step')
    return fields

class WorkbenchHandler(SimpleHTTPRequestHandler):
    def json_response(self,status,result):
        data=json.dumps(result,ensure_ascii=False,allow_nan=False).encode('utf-8')
        try:
            self.send_response(status);self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Content-Length',str(len(data)));self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(data)
        except (BrokenPipeError,ConnectionResetError,ConnectionAbortedError):
            pass  # The client discarded this job; accepted state lives there.
    def do_GET(self):
        if self.path=='/api/health':
            self.json_response(200,{'version':1,'referenceAvailable':self.server.solver is not None,'message':self.server.solver_error,'manufacturing':'unverified',**self.server.solver_metadata});return
        if self.path.startswith('/api/'):
            self.json_response(404,{'message':'未知本地计算接口'});return
        super().do_GET()
    def do_POST(self):
        if self.path!='/api/reference-step':
            self.json_response(404,{'message':'未知本地计算接口'});return
        # No cross-origin requests to the user's local numerical process.
        origin=self.headers.get('Origin')
        allowed={f'http://127.0.0.1:{self.server.server_port}',f'http://localhost:{self.server.server_port}'}
        if origin is not None and origin not in allowed:
            self.json_response(403,{'message':'只接受本地工作台同源请求'});return
        try:
            length=int(self.headers.get('Content-Length','0'))
            if length<=0 or length>MAX_REQUEST_BYTES: raise ValueError('本地计算请求必须在 16 MB 以内')
            payload=json.loads(self.rfile.read(length),parse_constant=lambda value:(_ for _ in ()).throw(ValueError(f'无效数值 {value}')))
            fields=identity(payload)
        except (ValueError,TypeError,UnicodeDecodeError) as error:
            self.json_response(400,{'committed':False,'message':str(error)});return
        if self.server.solver is None:
            self.json_response(503,{**fields,'committed':False,'message':self.server.solver_error or '本地参考依赖不可用'});return
        if not self.server.solver_lock.acquire(blocking=False):
            self.json_response(429,{**fields,'committed':False,'advancedTime':0,'message':'前一项本地计算尚未结束；此步未提交，请稍后重新计算。'});return
        try:
            try:
                result=self.server.solver(payload)
            finally:
                self.server.solver_lock.release()
            if not isinstance(result,dict): raise ValueError('求解器返回格式无效')
            result={**result,**fields}
            result['runtime']=self.server.solver_metadata
            # Serialize before writing headers; invalid native numbers are errors.
            json.dumps(result,allow_nan=False)
            self.json_response(200,result)
        except Exception as error:
            self.json_response(422,{**fields,'committed':False,'advancedTime':0,'message':str(error)})
    def log_message(self,format,*args):
        if self.path.startswith('/api/') or self.command=='POST': super().log_message(format,*args)

def make_server(*,port=4197,solver=None,solver_error=None):
    httpd=ThreadingHTTPServer(('127.0.0.1',port),partial(WorkbenchHandler,directory=str(PROJECT/'dist')))
    httpd.solver=solver;httpd.solver_error=solver_error;httpd.solver_lock=threading.Lock();httpd.solver_metadata=getattr(solver,'__silk_metadata__',{})
    return httpd

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,default=4197);parser.add_argument('--static-only',action='store_true');args=parser.parse_args()
    solver,error=(None,'静态模式未启用本地参考计算') if args.static_only else load_reference_solver()
    httpd=make_server(port=args.port,solver=solver,solver_error=error)
    print(json.dumps({'url':f'http://127.0.0.1:{httpd.server_port}','referenceAvailable':solver is not None,'message':error},ensure_ascii=False),flush=True)
    try: httpd.serve_forever()
    except KeyboardInterrupt: pass
    finally: httpd.server_close()

if __name__=='__main__': main()
