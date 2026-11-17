// See https://graph.facebook.com/v12.0/me for the docs (a comment never counts)
const BASE_URL = 'https://graph.facebook.com/v18.0'

async function call(path) {
  const url = `${BASE_URL}${path}`
  return request(url)
}
