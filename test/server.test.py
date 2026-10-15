"""Local HTTP contract tests; no native library is mocked as physically valid."""
import importlib.util
import json
from pathlib import Path
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

spec = importlib.util.spec_from_file_location('silk_server', Path(__file__).parents[1] / 'scripts/server.py')
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)

class LocalServerTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        def solver(payload):
            self.calls.append(payload)
            if payload.get('fail'):
                raise ValueError('fixture rejected')
            return {'committed': False, 'message': 'contract fixture does not run physics', 'epoch': 999}
        self.httpd = server.make_server(port=0, solver=solver)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.url = f'http://127.0.0.1:{self.httpd.server_port}'
    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join()
    def request(self, path, value=None, origin=None):
        headers = {'Content-Type': 'application/json'}
        if origin: headers['Origin'] = origin
        request = Request(self.url+path, data=json.dumps(value).encode() if value is not None else None, headers=headers)
        try:
            response = urlopen(request, timeout=5)
        except HTTPError as response:
            return response.code, response.read()
        return response.status, response.read()
    def payload(self):
        return {'version': 1, 'epoch': 2, 'requestId': 1, 'designRevision': 7, 'baseStateId': 0, 'snapshot': {}, 'context': {}, 'step': {}}
    def test_static_lab_and_native_health_share_one_origin(self):
        status, body = self.request('/lab.html')
        self.assertEqual(status, 200)
        self.assertIn(b'id="viewport"', body)
        status, body = self.request('/api/health')
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)['referenceAvailable'])
    def test_homepage_is_the_workshop(self):
        status, body = self.request('/index.html')
        self.assertEqual(status, 200)
        self.assertIn(b'id="workshop-viewport"', body)
    def test_request_identity_is_echoed_from_request_not_solver_result(self):
        payload=self.payload(); status, body=self.request('/api/reference-step', payload)
        result=json.loads(body)
        self.assertEqual(status, 200)
        for key in ['version','epoch','requestId','designRevision','baseStateId']:
            self.assertEqual(result[key], payload[key])
        self.assertFalse(result['committed'])
        self.assertEqual(len(self.calls), 1)
    def test_bad_identity_and_cross_origin_do_not_enter_solver(self):
        for fields in [{'version':2},{'epoch':True},{'requestId':0},{'baseStateId':-1}]:
            status,_=self.request('/api/reference-step', self.payload()|fields)
            self.assertEqual(status,400)
        self.assertEqual(self.request('/api/reference-step', self.payload(), origin='https://example.com')[0],403)
        self.assertEqual(self.calls,[])
    def test_solver_failure_is_json_and_next_request_still_works(self):
        status,body=self.request('/api/reference-step', self.payload()|{'fail':True})
        self.assertEqual(status,422)
        self.assertFalse(json.loads(body)['committed'])
        self.assertEqual(self.request('/api/reference-step',self.payload())[0],200)
    def test_unknown_api_never_becomes_a_static_post(self):
        self.assertEqual(self.request('/api/unknown',self.payload())[0],404)
    def test_an_aborted_or_slow_job_cannot_build_an_unbounded_native_queue(self):
        entered=threading.Event();release=threading.Event();first=[]
        def slow(payload):
            entered.set();release.wait(5)
            return {'committed':False,'message':'contract fixture'}
        self.httpd.solver=slow
        worker=threading.Thread(target=lambda:first.append(self.request('/api/reference-step',self.payload())),daemon=True)
        worker.start()
        try:
            self.assertTrue(entered.wait(2))
            status,body=self.request('/api/reference-step',self.payload()|{'requestId':2})
            self.assertEqual(status,429)
            self.assertFalse(json.loads(body)['committed'])
        finally:
            release.set();worker.join(5)
        self.assertEqual(first[0][0],200)

if __name__=='__main__': unittest.main()
