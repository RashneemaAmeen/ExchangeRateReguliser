Test-only TLS fixtures. `test-cert.pem` / `test-key.pem` are a self-signed certificate for localhost, generated for
`oanda.test.ts` to prove that certificate checking stays ON by default and that an extra CA can be trusted explicitly.
They protect nothing and must never be used outside the tests.
