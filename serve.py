import http.server
import socketserver
import os
import sys

DEFAULT_PORT = 8000
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

class MyHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        # Enable CORS and disable browser caching during development
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

class ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True

def start_server(start_port=DEFAULT_PORT, max_attempts=10):
    port = start_port
    for _ in range(max_attempts):
        try:
            httpd = ReusableTCPServer(("", port), MyHandler)
            print(f"Serving files from {DIRECTORY} on port {port}")
            print(f"Open http://localhost:{port} in your web browser.")
            with httpd:
                try:
                    httpd.serve_forever()
                except KeyboardInterrupt:
                    print("\nServer stopped.")
            return
        except OSError as e:
            if e.errno == 98:  # Address already in use
                print(f"Port {port} is already in use, trying port {port + 1}...")
                port += 1
            else:
                raise e
    print(f"Error: Could not bind to any port between {start_port} and {port - 1}.")
    sys.exit(1)

if __name__ == "__main__":
    start_server()

