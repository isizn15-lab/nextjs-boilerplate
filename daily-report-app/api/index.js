const app = require('../server');

module.exports = (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const originalPath = url.searchParams.get('__path') || '';
  url.searchParams.delete('__path');
  const query = url.searchParams.toString();
  req.url = `/${originalPath}${query ? `?${query}` : ''}`;
  return app(req, res);
};
