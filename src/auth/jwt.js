import jwt from 'jsonwebtoken';
import config from '../config/config.js';

export const generateToken = (payload) => {
  return jwt.sign(payload, config.admin.jwtSecret, { expiresIn: '24h' });
};

export const verifyToken = (token) => {
  return jwt.verify(token, config.admin.jwtSecret);
};

export const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  
  if (!token) {
    return res.status(401).json({ error: 'Token required' });
  }
  
  try {
    const decoded = verifyToken(token);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};